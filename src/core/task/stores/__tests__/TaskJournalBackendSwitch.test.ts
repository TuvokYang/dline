import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { StoredEntityClass } from "../../../storage/backend/api/EntitySchema"
import {
    closeInstanceStoragesUnder,
    databaseLocation,
    ensureInstanceLayout,
    INSTANCE_BACKEND_ENV,
    InstanceBackend,
    InstanceDatabase,
    openInstanceStorage,
    switchInstanceDatabaseBackend,
} from "../../../storage/instance"
import type { Command } from "../../kernel"
import { openTaskJournalStores } from "../sqlite"
import { BackgroundDeliveryRow, CommandPublicationRow, JournalEntryRow, PayloadRow } from "../sqlite/entities"

const JOURNAL_ENTITIES = [
    JournalEntryRow,
    CommandPublicationRow,
    PayloadRow,
    BackgroundDeliveryRow,
] as unknown as StoredEntityClass<object>[]
const encoder = new TextEncoder()

const PREPARE_KEY = "dialog.prepare:interaction-1"

const command: Command = {
    type: "dialog.prepare",
    commandId: "prepare-1",
    originRevision: 1,
    generation: 0,
    interactionId: "interaction-1",
    turnId: "turn-1",
    kind: "question",
    presentationRef: "question:1",
    actionRules: [],
    prepareKey: PREPARE_KEY,
}

async function exists(location: string): Promise<boolean> {
    return (await import("node:fs/promises")).access(location).then(
        () => true,
        () => false,
    )
}

describe("switching journal.db between SQLite and JSONL", () => {
    let documentsRoot: string

    beforeEach(async () => {
        documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-journal-switch-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
    })

    afterEach(async () => {
        vi.unstubAllEnvs()
        await closeInstanceStoragesUnder(documentsRoot)
        await rm(documentsRoot, { recursive: true, force: true })
    })

    async function snapshot(taskId: string) {
        const layout = await ensureInstanceLayout({ taskId })
        const storage = openInstanceStorage(layout.root)
        try {
            const stores = await openTaskJournalStores(await storage.openDatabase(InstanceDatabase.Journal, "reader"))
            const entries = await stores.journal.read()
            const payloads = await Promise.all(
                entries
                    .filter((entry) => entry.payloadRef?.startsWith("sha256:"))
                    .map((entry) => stores.payloads.read(entry.payloadRef!)),
            )
            return {
                backend: storage.openBackends().get(InstanceDatabase.Journal),
                entries,
                projection: await stores.journal.project(),
                payloads: payloads.map((bytes) => Array.from(bytes)),
                published: await stores.publications.has(PREPARE_KEY),
                backgroundDeliveries: await stores.backgroundDeliveries.listPending(),
            }
        } finally {
            await storage.close()
        }
    }

    it.each([
        [InstanceBackend.Sqlite, InstanceBackend.Jsonl],
        [InstanceBackend.Jsonl, InstanceBackend.Sqlite],
    ])("moves a journal from %s to %s and back without losing anything", async (from, to) => {
        vi.stubEnv(INSTANCE_BACKEND_ENV, from)
        const taskId = `task-${from}-${to}`
        const layout = await ensureInstanceLayout({ taskId })
        const writer = openInstanceStorage(layout.root)
        const stores = await openTaskJournalStores(await writer.openDatabase(InstanceDatabase.Journal, "kernel-commit"))
        const first = await stores.payloads.put(encoder.encode("first message"))
        const binary = await stores.payloads.put(new Uint8Array([0, 10, 13, 255, 128]))
        await stores.journal.append({
            operationId: "intake:1",
            payloadRef: first,
            source: "intake",
            causation: { commandId: "c-1", turnId: "t-1" },
        })
        await stores.journal.append({ operationId: "provider:2", payloadRef: binary, source: "provider" })
        await stores.journal.supersedeRange({ operationId: "compact:1", from: { seq: 1 }, to: { seq: 1 }, replacementRef: first })
        await stores.journal.tombstone({ operationId: "tombstone:1", target: { seq: 2 } })
        await stores.publications.mark(command, PREPARE_KEY)
        await stores.backgroundDeliveries.stage({
            entryId: "background:subagent:job-1:attempt:1",
            producerKind: "subagent",
            producerId: "job-1",
            attempt: 1,
            text: "background result",
        })
        await writer.close()
        const before = await snapshot(taskId)
        expect(before.backend).toBe(from)

        const moved = await switchInstanceDatabaseBackend(layout, InstanceDatabase.Journal, to, JOURNAL_ENTITIES)
        expect(moved).toMatchObject({ from, to, sourceRetained: false })
        expect(moved.rowsByCollection.get(JournalEntryRow.storage.schemaId)).toBe(4)
        expect(await exists(databaseLocation(layout, InstanceDatabase.Journal, from))).toBe(false)

        const after = await snapshot(taskId)
        expect(after).toEqual({ ...before, backend: to })

        // The moved journal keeps accepting writes with contiguous sequence numbers.
        const reopened = openInstanceStorage(layout.root)
        const next = await openTaskJournalStores(await reopened.openDatabase(InstanceDatabase.Journal, "kernel-commit"))
        await expect(next.journal.append({ operationId: "intake:5", payloadRef: first, source: "intake" })).resolves.toEqual({
            watermark: { seq: 5 },
            disposition: "appended",
        })
        await reopened.close()

        await switchInstanceDatabaseBackend(layout, InstanceDatabase.Journal, from, JOURNAL_ENTITIES)
        const back = await snapshot(taskId)
        expect(back.backend).toBe(from)
        expect(back.entries).toHaveLength(5)
        expect(back.entries.slice(0, 4)).toEqual(before.entries)
        expect(back.payloads.slice(0, before.payloads.length)).toEqual(before.payloads)
    })

    it("refuses to switch a database that is open in this process", async () => {
        const layout = await ensureInstanceLayout({ taskId: "task-open" })
        const storage = openInstanceStorage(layout.root)
        await openTaskJournalStores(await storage.openDatabase(InstanceDatabase.Journal, "kernel-commit"))

        await expect(
            switchInstanceDatabaseBackend(layout, InstanceDatabase.Journal, InstanceBackend.Jsonl, JOURNAL_ENTITIES),
        ).rejects.toThrow(/Close every storage/)
        await storage.close()
    })

    it("refuses to drop a collection the switch does not know and leaves the source untouched", async () => {
        const layout = await ensureInstanceLayout({ taskId: "task-unknown" })
        const storage = openInstanceStorage(layout.root)
        const stores = await openTaskJournalStores(await storage.openDatabase(InstanceDatabase.Journal, "kernel-commit"))
        await stores.journal.append({ operationId: "intake:1", payloadRef: "p", source: "intake" })
        await storage.close()

        await expect(
            switchInstanceDatabaseBackend(layout, InstanceDatabase.Journal, InstanceBackend.Jsonl, [
                JournalEntryRow as unknown as StoredEntityClass<object>,
            ]),
        ).rejects.toThrow(/unknown UnifyStore collection/)
        expect(await exists(databaseLocation(layout, InstanceDatabase.Journal, InstanceBackend.Sqlite))).toBe(true)
        expect(await exists(databaseLocation(layout, InstanceDatabase.Journal, InstanceBackend.Jsonl))).toBe(false)
        expect((await snapshot("task-unknown")).entries).toHaveLength(1)
    })

    it("prefers the newer copy when a switch could not remove its source", async () => {
        vi.stubEnv(INSTANCE_BACKEND_ENV, InstanceBackend.Sqlite)
        const layout = await ensureInstanceLayout({ taskId: "task-leftover" })
        const writer = openInstanceStorage(layout.root)
        const stores = await openTaskJournalStores(await writer.openDatabase(InstanceDatabase.Journal, "kernel-commit"))
        await stores.journal.append({ operationId: "intake:1", payloadRef: "p", source: "intake" })
        await writer.close()
        await switchInstanceDatabaseBackend(layout, InstanceDatabase.Journal, InstanceBackend.Jsonl, JOURNAL_ENTITIES)

        // Simulates a source another window kept open, so the switch could not delete it.
        const { SqliteUnifyStoreBackend } = await import("../../../storage/backend/sqlite/SqliteUnifyStore")
        const leftover = await new SqliteUnifyStoreBackend().open(
            databaseLocation(layout, InstanceDatabase.Journal, InstanceBackend.Sqlite),
        )
        await leftover.openStore(JournalEntryRow)
        await leftover.close()

        const read = await snapshot("task-leftover")
        expect(read.backend).toBe(InstanceBackend.Jsonl)
        expect(read.entries).toHaveLength(1)
    })
})
