import { mkdtempSync, rmSync, statSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import type { HistoryItem } from "@shared/HistoryItem"
import { afterAll, describe, expect, it } from "vitest"
import type { UnifyStore, UnifyStoreTransaction } from "../backend/api/UnifyStore"
import { SqliteUnifyStoreBackend } from "../backend/sqlite/SqliteUnifyStore"
import { TaskHistoryRow } from "../entities/TaskHistoryRow"
import { openTaskHistory, TaskHistory } from "../TaskHistory"

/**
 * Behavior guard for republishing a history entry that did not change.
 *
 * Every durable message boundary publishes the whole entry again, so most
 * updates carry no change at all. Writing one anyway rewrites the entire table,
 * and the resulting database change wakes this process's own file watcher,
 * which republishes state to every controller. During a command that fires many
 * boundaries in a row this turned into a continuous rebuild of a state that
 * nobody had changed.
 */

const roots: string[] = []

function createDatabasePath(): string {
    const root = mkdtempSync(path.join(os.tmpdir(), "dline-history-idempotent-"))
    roots.push(root)
    return path.join(root, "taskHistory.db")
}

function createItem(overrides: Partial<HistoryItem> = {}): HistoryItem {
    return {
        id: "task-1",
        ulid: "ulid-1",
        ts: 1_000,
        task: "example task",
        tokensIn: 10,
        tokensOut: 20,
        cacheWrites: 0,
        cacheReads: 0,
        totalCost: 0,
        size: 0,
        ...overrides,
    } as HistoryItem
}

/** Total bytes of the database and its write-ahead log. */
function storageFootprint(databasePath: string): number {
    let total = 0
    for (const suffix of ["", "-wal"]) {
        try {
            total += statSync(`${databasePath}${suffix}`).size
        } catch {
            // A sidecar that does not exist contributes nothing.
        }
    }
    return total
}

afterAll(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true })
})

/** What one `upsert` asked the store to write. */
interface RecordedWrite {
    upsertedIds: string[]
    replacedAll: boolean
}

/**
 * Wrap a real store so each transaction records the write shape it used.
 *
 * Every other operation forwards unchanged; only the transaction handle is
 * instrumented, because that is where `TaskHistory` chooses between writing one
 * row and rewriting the collection.
 */
function recordingStore(inner: UnifyStore<TaskHistoryRow>, writes: RecordedWrite[]): UnifyStore<TaskHistoryRow> {
    return {
        query: (query) => inner.query(query),
        insert: (records) => inner.insert(records),
        upsert: (records) => inner.upsert(records),
        replaceAll: (records, hint) => inner.replaceAll(records, hint),
        stats: () => inner.stats(),
        close: () => inner.close(),
        transaction: async <TResult>(
            operation: (transaction: UnifyStoreTransaction<TaskHistoryRow>) => TResult | Promise<TResult>,
        ) =>
            inner.transaction(async (transaction) => {
                const recorded: RecordedWrite = { upsertedIds: [], replacedAll: false }
                writes.push(recorded)
                return await operation({
                    query: (query) => transaction.query(query),
                    insert: (records) => transaction.insert(records),
                    upsert: async (records) => {
                        recorded.upsertedIds.push(...records.map((row) => row.id))
                        await transaction.upsert(records)
                    },
                    replaceAll: async (records, hint) => {
                        recorded.replacedAll = true
                        await transaction.replaceAll(records, hint)
                    },
                })
            }),
    }
}

/** Open a history store that records what each write asked the store to do. */
async function openRecordingHistory(databasePath: string): Promise<{ history: TaskHistory; writes: RecordedWrite[] }> {
    const database = await new SqliteUnifyStoreBackend().open(databasePath)
    const store = await database.openStore(TaskHistoryRow)
    const writes: RecordedWrite[] = []
    return { history: new TaskHistory(recordingStore(store, writes), database), writes }
}

describe("TaskHistory.upsert", () => {
    it("does not rewrite the table when the entry is unchanged", async () => {
        const databasePath = createDatabasePath()
        const history = await openTaskHistory(databasePath)
        try {
            const item = createItem()
            await history.upsert(item)
            await history.flush()
            const afterFirstWrite = storageFootprint(databasePath)

            for (let attempt = 0; attempt < 20; attempt++) {
                await history.upsert(createItem())
            }
            await history.flush()

            // A republished identical entry must not reach storage at all, so the
            // files cannot have grown.
            expect(storageFootprint(databasePath)).toBe(afterFirstWrite)
            expect((await history.getById("task-1"))?.task).toBe("example task")
        } finally {
            await history.dispose()
        }
    })

    it("still persists a real change", async () => {
        const databasePath = createDatabasePath()
        const history = await openTaskHistory(databasePath)
        try {
            await history.upsert(createItem())
            await history.flush()

            await history.upsert(createItem({ tokensOut: 999, task: "updated task" }))
            await history.flush()

            const stored = await history.getById("task-1")
            expect(stored?.tokensOut).toBe(999)
            expect(stored?.task).toBe("updated task")
        } finally {
            await history.dispose()
        }
    })

    it("updates one entry without rewriting its neighbours", async () => {
        const databasePath = createDatabasePath()
        const { history, writes } = await openRecordingHistory(databasePath)
        try {
            const neighbours = Array.from({ length: 40 }, (_, index) =>
                createItem({ id: `neighbour-${index}`, ulid: `ulid-n-${index}`, ts: index + 1, task: `neighbour ${index}` }),
            )
            for (const neighbour of neighbours) await history.upsert(neighbour)
            await history.flush()
            writes.length = 0

            await history.upsert(createItem({ tokensOut: 777 }))
            await history.flush()

            // The contract is the write shape, not the resulting file size: a
            // whole-collection rewrite also lands a correct table, so comparing
            // bytes could pass while 40 untouched rows were republished.
            expect(writes.map((write) => write.upsertedIds)).toEqual([["task-1"]])
            expect(writes.some((write) => write.replacedAll)).toBe(false)

            expect((await history.getById("task-1"))?.tokensOut).toBe(777)
            for (const neighbour of neighbours) {
                expect((await history.getById(neighbour.id))?.task).toBe(neighbour.task)
            }
        } finally {
            await history.dispose()
        }
    })

    it("keeps the committed completion projection when metadata repeats", async () => {
        const databasePath = createDatabasePath()
        const history = await openTaskHistory(databasePath)
        try {
            await history.upsert(createItem())
            await history.setCompletionState({ taskId: "task-1", isCompleted: true, revision: 1 })
            await history.flush()

            // Metadata is built from a snapshot that never carries completion, so
            // skipping the write must not be mistaken for dropping it either.
            await history.upsert(createItem())
            await history.flush()

            expect((await history.getById("task-1"))?.isCompleted).toBe(true)
        } finally {
            await history.dispose()
        }
    })
})
