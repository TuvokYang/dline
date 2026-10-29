import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
    closeInstanceStoragesUnder,
    ensureInstanceLayout,
    InstanceDatabase,
    openInstanceStorage,
} from "../../../storage/instance"
import type { Command } from "../../kernel"
import { KERNEL_COMMIT_WRITER, openTaskPersistence } from "../../shell/TaskPersistenceAssembly"
import { openTaskJournalStores } from "../sqlite"

const encoder = new TextEncoder()
const decoder = new TextDecoder()

async function openStores(taskId: string, writer = KERNEL_COMMIT_WRITER) {
    const layout = await ensureInstanceLayout({ taskId })
    const storage = openInstanceStorage(layout.root)
    const stores = await openTaskJournalStores(await storage.openDatabase(InstanceDatabase.Journal, writer))
    return { layout, storage, stores }
}

const prepareCommand: Command = {
    type: "dialog.prepare",
    commandId: "prepare-1",
    originRevision: 1,
    generation: 0,
    interactionId: "interaction-1",
    turnId: "turn-1",
    kind: "question",
    presentationRef: "question:1",
    actionRules: [],
    prepareKey: "dialog.prepare:interaction-1",
}

describe("SQLite task journal stores", () => {
    let documentsRoot: string

    beforeEach(async () => {
        documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-journal-db-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
    })

    afterEach(async () => {
        vi.unstubAllEnvs()
        await closeInstanceStoragesUnder(documentsRoot)
        await rm(documentsRoot, { recursive: true, force: true })
    })

    it("reloads the journal exactly as it was written, with contiguous sequence numbers", async () => {
        const first = await openStores("task-journal")
        const { journal } = first.stores
        await expect(
            journal.append({
                operationId: "intake:1",
                payloadRef: "payload-1",
                source: "intake",
                causation: { commandId: "command-1", turnId: "turn-1" },
            }),
        ).resolves.toEqual({ watermark: { seq: 1 }, disposition: "appended" })
        await journal.append({ operationId: "provider:2", payloadRef: "payload-2", source: "provider" })
        await journal.supersedeRange({ operationId: "compact:1", from: { seq: 2 }, to: { seq: 2 }, replacementRef: "summary" })
        await journal.tombstone({ operationId: "tombstone:1", target: { seq: 1 } })
        const written = await journal.read()
        await first.storage.close()

        const second = await openStores("task-journal")
        const reopened = second.stores.journal
        expect(reopened.watermark()).toEqual({ seq: 4 })
        expect(await reopened.read()).toEqual(written)
        expect(written[0]).toEqual({
            version: 1,
            operationId: "intake:1",
            kind: "message",
            watermark: { seq: 1 },
            payloadRef: "payload-1",
            source: "intake",
            causation: { commandId: "command-1", turnId: "turn-1" },
        })
        expect((await reopened.project()).visibleMessages.map((message) => message.payloadRef)).toEqual(["summary"])
        await expect(reopened.append({ operationId: "intake:5", payloadRef: "payload-5", source: "intake" })).resolves.toEqual({
            watermark: { seq: 5 },
            disposition: "appended",
        })
    })

    it("answers a repeated operation with its first record after reopen and refuses different content", async () => {
        const first = await openStores("task-idempotent")
        await first.stores.journal.append({
            operationId: "intake:1",
            payloadRef: "payload-1",
            source: "intake",
            causation: { commandId: "command-1", turnId: "turn-1" },
        })
        await first.storage.close()

        const { journal } = (await openStores("task-idempotent")).stores
        // Key order of the causation does not change the operation's identity.
        await expect(
            journal.append({
                operationId: "intake:1",
                payloadRef: "payload-1",
                source: "intake",
                causation: { turnId: "turn-1", commandId: "command-1" },
            }),
        ).resolves.toEqual({ watermark: { seq: 1 }, disposition: "existing" })
        await expect(
            journal.append({
                operationId: "intake:1",
                payloadRef: "payload-1",
                source: "intake",
                causation: { turnId: "turn-replayed", commandId: "command-replayed", generation: 3 },
            }),
        ).resolves.toEqual({ watermark: { seq: 1 }, disposition: "existing" })
        await expect(journal.append({ operationId: "intake:1", payloadRef: "other", source: "intake" })).rejects.toThrow(
            "Journal operation conflict: intake:1",
        )
        expect(journal.watermark()).toEqual({ seq: 1 })
        expect(await journal.read()).toHaveLength(1)
    })

    it("finalizes a transient identity with the durable payload supplied at settlement", async () => {
        const first = await openStores("task-transient")
        const { journal } = first.stores
        journal.appendTransient("draft-1")
        await expect(
            journal.finalizeTransient({
                operationId: "provider:1",
                payloadRef: "draft-payload",
                source: "provider",
                transientId: "draft-1",
            }),
        ).resolves.toEqual({ watermark: { seq: 1 }, disposition: "appended" })
        await expect(
            journal.finalizeTransient({ operationId: "provider:2", payloadRef: "", source: "provider", transientId: "missing" }),
        ).rejects.toThrow("Unknown transient journal entry: missing")
        await first.storage.close()

        const reopened = (await openStores("task-transient")).stores.journal
        await expect(
            reopened.finalizeTransient({
                operationId: "provider:1",
                payloadRef: "draft-payload",
                source: "provider",
                transientId: "draft-replayed",
                causation: { commandId: "replayed", generation: 2 },
            }),
        ).resolves.toEqual({ watermark: { seq: 1 }, disposition: "existing" })
        const [entry] = await reopened.read()
        expect(entry).toMatchObject({ operationId: "provider:1", payloadRef: "draft-payload", transientId: "draft-1" })
    })

    it("keeps published effect keys and payloads across reopen", async () => {
        const first = await openStores("task-publications")
        await first.stores.publications.mark(prepareCommand, prepareCommand.prepareKey)
        await first.stores.publications.mark(prepareCommand, prepareCommand.prepareKey)
        const payloadRef = await first.stores.payloads.put(encoder.encode("hello"))
        expect(payloadRef).toMatch(/^sha256:[a-f0-9]{64}$/)
        // Equal bytes address the same stored payload.
        await expect(first.stores.payloads.put(encoder.encode("hello"))).resolves.toBe(payloadRef)
        await first.storage.close()

        const { publications, payloads } = (await openStores("task-publications")).stores
        expect(await publications.has(prepareCommand.prepareKey)).toBe(true)
        expect(await publications.has("dialog.prepare:other")).toBe(false)
        expect(decoder.decode(await payloads.read(payloadRef))).toBe("hello")
    })

    it("reopens pending background deliveries and keeps acknowledged records out of replay", async () => {
        const first = await openStores("task-background-delivery")
        const staged = {
            entryId: "background:subagent:job-1:attempt:2",
            producerKind: "subagent" as const,
            producerId: "job-1",
            attempt: 2,
            text: "# Background Results\n## Background Subagent Results\n- job-1: completed",
        }
        await expect(first.stores.backgroundDeliveries.stage(staged)).resolves.toEqual({ ...staged, state: "pending" })
        await first.storage.close()

        const second = await openStores("task-background-delivery")
        await expect(second.stores.backgroundDeliveries.listPending()).resolves.toEqual([{ ...staged, state: "pending" }])
        await expect(second.stores.backgroundDeliveries.stage(staged)).resolves.toEqual({ ...staged, state: "pending" })
        await expect(second.stores.backgroundDeliveries.stage({ ...staged, text: "different" })).rejects.toThrow(
            "BackgroundDeliveryConflict",
        )
        await second.stores.backgroundDeliveries.acknowledge(staged.entryId)
        await second.storage.close()

        const third = await openStores("task-background-delivery")
        await expect(third.stores.backgroundDeliveries.listPending()).resolves.toEqual([])
    })

    it("distinguishes a malformed payload reference from a missing payload", async () => {
        const { payloads } = (await openStores("task-payload-errors")).stores

        await expect(payloads.read(`sha256:${"0".repeat(64)}`)).rejects.toThrow("TaskPayloadNotFound")
        await expect(payloads.read("payload-1")).rejects.toThrow("InvalidTaskPayloadRef")
    })

    it("lets a second session of the same task read the journal but not write it", async () => {
        const first = await openStores("task-shared")
        await first.stores.journal.append({ operationId: "intake:1", payloadRef: "payload-1", source: "intake" })
        const payloadRef = await first.stores.payloads.put(encoder.encode("shared"))

        const second = await openStores("task-shared")
        expect(second.stores.journal.watermark()).toEqual({ seq: 1 })
        expect(decoder.decode(await second.stores.payloads.read(payloadRef))).toBe("shared")
        await expect(
            second.stores.journal.append({ operationId: "intake:2", payloadRef: "payload-2", source: "intake" }),
        ).rejects.toThrow(/InstanceDatabaseWriterConflict: journal\.db .* is written by kernel-commit/)
        await expect(second.stores.payloads.put(encoder.encode("intruder"))).rejects.toThrow(/InstanceDatabaseWriterConflict/)
        await expect(second.stores.publications.mark(prepareCommand)).rejects.toThrow(/InstanceDatabaseWriterConflict/)

        // The rejected writes never reached the file.
        await first.storage.close()
        await second.storage.close()
        const reopened = (await openStores("task-shared")).stores
        expect(reopened.journal.watermark()).toEqual({ seq: 1 })
        expect(await reopened.publications.has(prepareCommand.commandId)).toBe(false)
    })

    it("assembles the kernel ports on journal.db and releases the file on close", async () => {
        const persistence = await openTaskPersistence("task-assembly")
        await persistence.ports.journal.append({ operationId: "intake:1", payloadRef: "payload-1", source: "intake" })
        const payloadRef = await persistence.payloads.put(encoder.encode("assembled"))
        const layout = await ensureInstanceLayout({ taskId: "task-assembly" })
        expect(await readdir(layout.root)).toContain("journal.db")

        const concurrent = await openTaskPersistence("task-assembly")
        await expect(
            concurrent.ports.journal.append({ operationId: "intake:2", payloadRef: "payload-2", source: "intake" }),
        ).rejects.toThrow(/InstanceDatabaseWriterConflict/)
        await concurrent.close?.()
        await persistence.close?.()

        const reopened = await openTaskPersistence("task-assembly")
        await expect(
            reopened.ports.journal.append({ operationId: "intake:2", payloadRef: "payload-2", source: "intake" }),
        ).resolves.toEqual({ watermark: { seq: 2 }, disposition: "appended" })
        expect(decoder.decode(await reopened.payloads.read(payloadRef))).toBe("assembled")
        await reopened.close?.()

        // Every handle is released, so the task directory can be deleted (Windows refuses while one is open).
        await rm(layout.root, { recursive: true })
        expect(await readdir(path.join(documentsRoot, "tasks"))).not.toContain("task-assembly")
    })
})
