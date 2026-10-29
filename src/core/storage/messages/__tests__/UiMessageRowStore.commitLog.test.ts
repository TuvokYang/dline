import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UiMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import type { StoredEntityClass } from "../../backend/api/EntitySchema"
import type { TransactionalUnifyStoreDatabase, UnifyStoreCollectionTransaction } from "../../backend/api/UnifyStore"
import { asc } from "../../backend/api/UnifyStoreQuery"
import { closeInstanceStoragesUnder, ensureInstanceLayout, InstanceDatabase, openInstanceStorage } from "../../instance"
import { databaseLocation, INSTANCE_BACKEND_ENV, InstanceBackend } from "../../instance/InstanceBackends"
import { InstanceLayout } from "../../instance/InstanceLayout"
import { importLegacyUiMessages } from "../importLegacyUiMessages"
import { openStoredUiMessageRows, UI_MESSAGE_READER, UI_MESSAGE_WRITER } from "../openUiMessageRows"
import { subscribeUiMessageCommits, UI_MESSAGE_COMMIT_RETENTION, UiMessageRowStore } from "../UiMessageRowStore"
import {
    UiMessageAttachmentRow,
    UiMessageCommitRow,
    UiMessageCommitStateRow,
    type UiMessageRecord,
    UiMessageRow,
} from "../UiMessageRows"

function say(ts: number, text = `row ${ts}`, extra: Partial<UiMessage> = {}): UiMessage {
    return { ts, type: "say", say: "text", text, ...extra } as UiMessage
}

function record(ordinal: number, message: UiMessage): UiMessageRecord {
    return { ordinal, ts: message.ts, message }
}

/** Ordinal i holds ts 1000 + 10 * i, so every row keeps the order. */
function rows(count: number, from = 0): UiMessageRecord[] {
    return Array.from({ length: count }, (_, index) => record(from + index, say(1_000 + (from + index) * 10)))
}

interface ReadCounter {
    rows: number
}

/** Counts every record a transaction reads, across all collections. */
function countingReads(database: TransactionalUnifyStoreDatabase, counter: ReadCounter): TransactionalUnifyStoreDatabase {
    return {
        hasStore: (entity) => database.hasStore(entity),
        openStore: (entity) => database.openStore(entity),
        collections: () => database.collections(),
        close: () => database.close(),
        transaction: (operation) =>
            database.transaction((transaction) =>
                operation({
                    store: <TEntity extends object>(
                        entity: StoredEntityClass<TEntity>,
                    ): UnifyStoreCollectionTransaction<TEntity> => {
                        const store: UnifyStoreCollectionTransaction<TEntity> = transaction.store(entity)
                        const counted: UnifyStoreCollectionTransaction<TEntity> = {
                            query: async (query) => {
                                const records = await store.query(query)
                                counter.rows += records.length
                                return records
                            },
                            insert: (records) => store.insert(records),
                            upsert: (records) => store.upsert(records),
                            replaceAll: (records) => store.replaceAll(records),
                            deleteWhere: (where) => store.deleteWhere(where),
                        }
                        return counted
                    },
                }),
            ),
    }
}

describe.each([InstanceBackend.Sqlite, InstanceBackend.Jsonl])("UiMessageRowStore commit log on %s", (backend) => {
    let documentsRoot: string

    beforeEach(async () => {
        documentsRoot = await mkdtemp(path.join(os.tmpdir(), "dline-commit-log-"))
        vi.stubEnv("DLINE_DOCS_DIR", documentsRoot)
        vi.stubEnv(INSTANCE_BACKEND_ENV, backend)
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await closeInstanceStoragesUnder(documentsRoot)
        vi.unstubAllEnvs()
        await rm(documentsRoot, { recursive: true, force: true })
    })

    async function open(taskId: string, counter?: ReadCounter) {
        const layout = await ensureInstanceLayout({ taskId })
        const storage = openInstanceStorage(layout.root)
        const raw = await storage.openDatabase(InstanceDatabase.Messages, UI_MESSAGE_WRITER)
        const database = counter ? countingReads(raw, counter) : raw
        const store = await UiMessageRowStore.open(database, () => storage.close(), layout.root)
        const commits = await raw.openStore(UiMessageCommitRow)
        const entries = async () =>
            (await commits.query({ orderBy: [asc(UiMessageCommitRow.storage.fields.seq)] })).records.map((entry) => ({
                seq: entry.seq,
                firstChangedOrdinal: entry.firstChangedOrdinal,
                committedLength: entry.committedLength,
                tsViolation: entry.tsViolation,
            }))
        return { root: layout.root, store, entries }
    }

    /** Creates `messages.db` holding only what `create` opens, as an older or partial writer left it. */
    async function writeCollections(
        taskId: string,
        create: (database: TransactionalUnifyStoreDatabase) => Promise<void>,
    ): Promise<string> {
        const layout = await ensureInstanceLayout({ taskId })
        const storage = openInstanceStorage(layout.root)
        await create(await storage.openDatabase(InstanceDatabase.Messages, UI_MESSAGE_WRITER))
        await storage.close()
        return layout.root
    }

    async function storedCollections(root: string): Promise<string[]> {
        const storage = openInstanceStorage(root)
        try {
            const database = await storage.openDatabase(InstanceDatabase.Messages, UI_MESSAGE_WRITER)
            return (await database.collections()).map((collection) => collection.schemaId).sort()
        } finally {
            await storage.close()
        }
    }

    it("reads a history written before the commit log as an empty log and leaves its schema unchanged", async () => {
        const root = await writeCollections("task-before-log", async (database) => {
            await database.openStore(UiMessageRow)
            await database.openStore(UiMessageAttachmentRow)
        })
        const before = await storedCollections(root)
        expect(before).toEqual([UiMessageAttachmentRow.storage.schemaId, UiMessageRow.storage.schemaId].sort())

        const reader = await openStoredUiMessageRows(root)
        if (!reader) throw new Error("the stored rows were not opened")
        expect(await reader.count()).toBe(0)
        expect(await reader.commitLog.head()).toEqual({ logId: null, headSeq: 0, violationTs: null })
        expect(await reader.commitLog.since(0)).toMatchObject({ headSeq: 0, minFirstChangedOrdinal: null })
        await reader.close()

        expect(await storedCollections(root)).toEqual(before)
    })

    it("adopts the commit log once the writer creates it, so a held reader keeps following commits", async () => {
        const root = await writeCollections("task-adopt-log", async (database) => {
            await database.openStore(UiMessageRow)
            await database.openStore(UiMessageAttachmentRow)
        })
        const reader = await openStoredUiMessageRows(root)
        if (!reader) throw new Error("the stored rows were not opened")
        expect((await reader.commitLog.head()).headSeq).toBe(0)

        const { store: writer } = await open("task-adopt-log")
        await writer.insert(rows(2))
        await writer.insert(rows(1, 2))

        const head = await reader.commitLog.head()
        expect(head.logId).not.toBeNull()
        expect(head.headSeq).toBe(2)
        expect(await reader.commitLog.since(1)).toMatchObject({ headSeq: 2, minFirstChangedOrdinal: 2 })
        await reader.close()
    })

    it("reads the commit log without opening a transaction, which on JSONL would take the writer lock", async () => {
        const { root, store: writer } = await open("task-reader-log")
        await writer.insert(rows(3))
        await writer.insert(rows(1, 3))
        await writer.close()

        const storage = openInstanceStorage(root)
        const raw = await storage.openDatabase(InstanceDatabase.Messages, UI_MESSAGE_READER)
        const readOnly: TransactionalUnifyStoreDatabase = {
            hasStore: (entity) => raw.hasStore(entity),
            openStore: (entity) => raw.openStore(entity),
            collections: () => raw.collections(),
            close: () => raw.close(),
            transaction: () => Promise.reject(new Error("a reader opened a transaction")),
        }
        const reader = await UiMessageRowStore.open(readOnly, () => storage.close(), root, "existing")

        expect(await reader.commitLog.since(0)).toMatchObject({ headSeq: 2, minFirstChangedOrdinal: 0, tsViolation: null })
        expect(await reader.commitLog.since(1)).toMatchObject({ headSeq: 2, minFirstChangedOrdinal: 3 })
        await reader.close()
    })

    it("treats a messages.db without its chat row collections as holding no rows and creates none", async () => {
        const root = await writeCollections("task-partial", async (database) => {
            await database.openStore(UiMessageCommitStateRow)
        })
        const before = await storedCollections(root)

        expect(await openStoredUiMessageRows(root)).toBeUndefined()

        expect(await storedCollections(root)).toEqual(before)
    })

    it("appends one entry per row transaction with the first ordinal it changed", async () => {
        const { store, entries } = await open("task-kinds")

        await store.insert(rows(3))
        await store.insert(rows(1, 3))
        await store.replaceTail({
            durableCount: 4,
            expectedTailTimestamps: [1_020, 1_030],
            replacedCount: 1,
            entries: [say(1_030, "final")],
        })
        await store.replaceAll([...rows(2), record(2, say(1_020, "edited")), ...rows(1, 3)], { firstChangedIndex: 2 })
        await store.replaceAll(rows(2))
        await store.transaction((transaction) => transaction.insert(rows(1, 2)))

        expect(await entries()).toEqual([
            { seq: 1, firstChangedOrdinal: 0, committedLength: 3, tsViolation: null },
            { seq: 2, firstChangedOrdinal: 3, committedLength: 4, tsViolation: null },
            { seq: 3, firstChangedOrdinal: 3, committedLength: 4, tsViolation: null },
            { seq: 4, firstChangedOrdinal: 2, committedLength: 4, tsViolation: null },
            { seq: 5, firstChangedOrdinal: 0, committedLength: 2, tsViolation: null },
            { seq: 6, firstChangedOrdinal: 2, committedLength: 3, tsViolation: null },
        ])
        const since = await store.commitLog.since(3)
        expect(since).toMatchObject({ headSeq: 6, minFirstChangedOrdinal: 0, tsViolation: null, violationTs: null })
        expect((await store.commitLog.since(5)).minFirstChangedOrdinal).toBe(2)
        expect((await store.commitLog.since(6)).minFirstChangedOrdinal).toBeNull()
    })

    it("appends no entry for a refused tail, a read-only transaction or a failed transaction", async () => {
        const { store, entries } = await open("task-noop")
        await store.insert(rows(2))

        expect(
            await store.replaceTail({ durableCount: 2, expectedTailTimestamps: [9], replacedCount: 1, entries: [say(9)] }),
        ).toBe(false)
        await store.transaction((transaction) => transaction.query())
        await expect(
            store.transaction(async (transaction) => {
                await transaction.insert(rows(1, 2))
                throw new Error("abort")
            }),
        ).rejects.toThrow("abort")
        await expect(store.insert(rows(1, 1))).rejects.toThrow()

        expect((await entries()).map((entry) => entry.seq)).toEqual([1])
        expect((await store.commitLog.head()).headSeq).toBe(1)
        expect((await store.query()).records).toHaveLength(2)
    })

    it("logs a legacy import as one commit from ordinal 0", async () => {
        const { root, store, entries } = await open("task-legacy")
        const legacy = [say(1_000), say(1_010), say(1_020)]
        await writeFile(path.join(root, "ui_messages.jsonl"), `${legacy.map((message) => JSON.stringify(message)).join("\n")}\n`)

        await importLegacyUiMessages(root, store)

        expect(await entries()).toEqual([{ seq: 1, firstChangedOrdinal: 0, committedLength: 3, tsViolation: null }])
    })

    it("keeps the log bounded, never under-reports through the floor, and keeps the first violation", async () => {
        const { store, entries } = await open("task-retention")
        await store.insert([record(0, say(1_000))])
        await store.insert([record(1, say(900))]) // violation: 900 after 1000
        await store.replaceAll([record(0, say(1_000)), record(1, say(1_010))], { firstChangedIndex: 1 }) // repair
        const extra = UI_MESSAGE_COMMIT_RETENTION + 2
        for (let index = 0; index < extra; index++) {
            const ordinal = 2 + index
            await store.insert([record(ordinal, say(1_000 + ordinal * 10))])
        }
        const headSeq = 3 + extra

        const kept = await entries()
        expect(kept).toHaveLength(UI_MESSAGE_COMMIT_RETENTION)
        expect(kept[0].seq).toBe(headSeq - UI_MESSAGE_COMMIT_RETENTION + 1)

        const head = await store.commitLog.head()
        expect(head).toMatchObject({ headSeq, violationTs: 900 })
        const all = await store.commitLog.since(0)
        expect(all).toMatchObject({ headSeq, minFirstChangedOrdinal: 0, violationTs: 900, tsViolation: null })
        const recent = await store.commitLog.since(headSeq - 10)
        expect(recent.minFirstChangedOrdinal).toBe(headSeq - 10 - 1)
    }, 120_000)

    it("keeps the log identity across reopen and gives a replaced messages.db a new one", async () => {
        const first = await open("task-identity")
        await first.store.insert(rows(1))
        const { logId } = await first.store.commitLog.head()
        expect(logId).toEqual(expect.any(String))
        await first.store.close()

        const reopened = await open("task-identity")
        await reopened.store.insert(rows(1, 1))
        expect(await reopened.store.commitLog.head()).toMatchObject({ logId, headSeq: 2 })
        await reopened.store.close()
        await closeInstanceStoragesUnder(documentsRoot)

        const location = databaseLocation(new InstanceLayout(reopened.root), InstanceDatabase.Messages, backend)
        for (const suffix of ["", "-wal", "-shm"]) await rm(`${location}${suffix}`, { recursive: true, force: true })

        const replaced = await open("task-identity")
        expect(await replaced.store.commitLog.head()).toEqual({ logId: null, headSeq: 0, violationTs: null })
        await replaced.store.insert(rows(1))
        const fresh = await replaced.store.commitLog.head()
        expect(fresh.headSeq).toBe(1)
        expect(fresh.logId).not.toBe(logId)
    })

    it("flags a ts that does not increase, reports only the instance and ts, and still writes the rows", async () => {
        const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
        const { store, entries } = await open("task-ts-order")
        await store.insert(rows(2)) // 1000, 1010
        await store.insert([record(2, say(1_010, "same ts"))])

        expect((await entries()).at(-1)?.tsViolation).toBe(1_010)
        expect((await store.query()).records).toHaveLength(3)
        const reports = warn.mock.calls
            .map(([line]) => /^\[messages\.db\] UiMessageTsOrderViolation: instance=(\S+) ts=(\S+)$/.exec(String(line)))
            .filter((match) => match !== null)
        expect(reports.map((match) => [match[1], match[2]])).toEqual([["task-ts-order", "1010"]])
        expect(await store.commitLog.head()).toMatchObject({ violationTs: 1_010 })
    })

    it("raises nothing when a partial row becomes final or a say becomes an ask at the same ordinal", async () => {
        const warn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
        const { store, entries } = await open("task-ts-same-ordinal")
        await store.insert([...rows(2), record(2, say(1_020, "partial", { partial: true }))])

        await store.replaceTail({
            durableCount: 3,
            expectedTailTimestamps: [1_010, 1_020],
            replacedCount: 1,
            entries: [say(1_020, "final", { partial: false })],
        })
        await store.replaceTail({
            durableCount: 3,
            expectedTailTimestamps: [1_010, 1_020],
            replacedCount: 1,
            entries: [{ ts: 1_020, type: "ask", ask: "followup", text: "question" } as UiMessage],
        })

        expect((await entries()).map((entry) => entry.tsViolation)).toEqual([null, null, null])
        expect(warn.mock.calls.filter(([line]) => String(line).includes("UiMessageTsOrderViolation"))).toEqual([])
        expect(await store.commitLog.head()).toMatchObject({ violationTs: null })
    })

    it("wakes subscribers of the root once per committed row transaction", async () => {
        const { root, store } = await open("task-signal")
        const other = await open("task-signal-other")
        let wakeups = 0
        let otherWakeups = 0
        const stop = subscribeUiMessageCommits(root, () => {
            wakeups++
        })
        subscribeUiMessageCommits(other.root, () => {
            otherWakeups++
        })
        subscribeUiMessageCommits(root, () => {
            throw new Error("listener failure stays with the listener")
        })
        vi.spyOn(Logger, "warn").mockImplementation(() => undefined)

        const legacy = [say(1_000), say(1_010)]
        await writeFile(path.join(root, "ui_messages.jsonl"), `${legacy.map((message) => JSON.stringify(message)).join("\n")}\n`)
        await importLegacyUiMessages(root, store)
        expect(wakeups).toBe(1)

        await store.insert(rows(1, 2))
        await store.transaction((transaction) => transaction.insert(rows(1, 3)))
        await store.transaction((transaction) => transaction.query())
        await expect(
            store.transaction(async (transaction) => {
                await transaction.insert(rows(1, 4))
                throw new Error("abort")
            }),
        ).rejects.toThrow("abort")
        expect(wakeups).toBe(3)

        stop()
        await store.insert(rows(1, 4))
        expect(wakeups).toBe(3)
        expect(otherWakeups).toBe(0)
    })

    it("reads a constant number of rows per commit whatever the history length", async () => {
        async function readsPerAppend(taskId: string, historyLength: number): Promise<number[]> {
            const counter: ReadCounter = { rows: 0 }
            const { store } = await open(taskId, counter)
            await store.insert(rows(historyLength))
            const measured: number[] = []
            counter.rows = 0
            await store.insert(rows(1, historyLength))
            measured.push(counter.rows)
            counter.rows = 0
            await store.replaceTail({
                durableCount: historyLength + 1,
                expectedTailTimestamps: [1_000 + historyLength * 10],
                replacedCount: 1,
                entries: [say(1_000 + historyLength * 10, "final")],
            })
            // The tail check of replaceTail itself reads the one expected row.
            measured.push(counter.rows - 1)
            return measured
        }

        const short = await readsPerAppend("task-reads-short", 20)
        const long = await readsPerAppend("task-reads-long", 600)
        expect(long).toEqual(short)
        for (const reads of long) expect(reads).toBeLessThanOrEqual(3)
    }, 60_000)
})
