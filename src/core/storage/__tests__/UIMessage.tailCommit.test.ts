import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { UiMessage } from "@/shared/ExtensionMessage"
import type { StoredEntityClass } from "../backend/api/EntitySchema"
import type { TransactionalUnifyStoreDatabase, UnifyStoreDatabaseTransaction } from "../backend/api/UnifyStore"
import { closeInstanceStoragesUnder, ensureInstanceLayout, InstanceDatabase, openInstanceStorage } from "../instance"
import { UiMessageRowStore } from "../messages/UiMessageRowStore"
import { UiMessageAttachmentRow } from "../messages/UiMessageRows"
import { UIMessage } from "../UIMessage"

// Long enough that a whole-history rewrite is the dominant cost, short enough for a unit test.
const HISTORY_LENGTH = 2_000

function message(index: number, overrides: Partial<UiMessage> = {}): UiMessage {
    return { ts: 1_000 + index, type: "say", say: "text", text: `message ${index}`, ...overrides } as UiMessage
}

describe("UIMessage tail commits on SQLite", () => {
    let docsDir: string

    beforeEach(async () => {
        docsDir = await mkdtemp(path.join(os.tmpdir(), "dline-ui-tail-commit-"))
        vi.stubEnv("DLINE_DOCS_DIR", docsDir)
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        await closeInstanceStoragesUnder(docsDir)
        vi.unstubAllEnvs()
        await rm(docsDir, { force: true, recursive: true })
    })

    async function seed(taskId: string): Promise<UiMessage[]> {
        const history = Array.from({ length: HISTORY_LENGTH }, (_, index) =>
            index === HISTORY_LENGTH - 1
                ? message(index, { images: ["data:image/png;base64,AAA", "data:image/png;base64,BBB"] })
                : message(index),
        )
        const writer = await UIMessage.open(taskId)
        await writer.overwrite(history)
        await writer.close()
        return history
    }

    /** Spies on the two paths that read or rewrite the whole history. */
    function watchWholeHistoryWrites() {
        return {
            replaceAll: vi.spyOn(UiMessageRowStore.prototype, "replaceAll"),
            merge: vi.spyOn(UiMessageRowStore.prototype, "transaction"),
        }
    }

    async function readBack(taskId: string): Promise<readonly UiMessage[]> {
        const reader = await UIMessage.open(taskId)
        const messages = [...reader.getAll()]
        await reader.close()
        return messages
    }

    it("patches the last message without rewriting the history", async () => {
        const history = await seed("tail-patch")
        const store = await UIMessage.open("tail-patch")
        const watched = watchWholeHistoryWrites()
        const tailWrites = vi.spyOn(UiMessageRowStore.prototype, "replaceTail")

        await store.updateMessage(HISTORY_LENGTH - 1, { text: "edited", images: ["data:image/png;base64,CCC"] })
        await store.flush()
        await store.close()

        expect(watched.replaceAll).not.toHaveBeenCalled()
        expect(watched.merge).not.toHaveBeenCalled()
        // The row store is asked about the edited row and its anchor only, however long the history.
        expect(tailWrites).toHaveBeenCalledTimes(1)
        expect(tailWrites.mock.calls[0][0]).toMatchObject({
            durableCount: HISTORY_LENGTH,
            replacedCount: 1,
            expectedTailTimestamps: [history[HISTORY_LENGTH - 2].ts, history[HISTORY_LENGTH - 1].ts],
        })
        vi.restoreAllMocks()
        const expected = [
            ...history.slice(0, -1),
            { ...history[HISTORY_LENGTH - 1], text: "edited", images: ["data:image/png;base64,CCC"] },
        ]
        expect(await readBack("tail-patch")).toEqual(expected)
    })

    // Explicit structural edits (insertAt, deleteAt, removeByTs) stay on the
    // transactional mutate path on purpose; these cases cover the staged edits
    // a running task produces on every streamed update.
    it("inserts a staged message before the last one without rewriting the history", async () => {
        const history = await seed("tail-insert")
        const store = await UIMessage.open("tail-insert")
        const watched = watchWholeHistoryWrites()
        const inserted = message(HISTORY_LENGTH - 1, { ts: 1_000 + HISTORY_LENGTH - 1.5, text: "inserted" })

        await store.upsertMessage(inserted)
        await store.flush()
        await store.close()

        expect(watched.replaceAll).not.toHaveBeenCalled()
        expect(watched.merge).not.toHaveBeenCalled()
        vi.restoreAllMocks()
        expect(await readBack("tail-insert")).toEqual([...history.slice(0, -1), inserted, history[HISTORY_LENGTH - 1]])
    })

    it("replaces the last message and drops its old attachments without rewriting the history", async () => {
        const history = await seed("tail-replace")
        const store = await UIMessage.open("tail-replace")
        const watched = watchWholeHistoryWrites()
        const replacement = message(HISTORY_LENGTH - 1, { text: "replaced without images" })

        await store.updateAt(HISTORY_LENGTH - 1, replacement)
        await store.flush()
        await store.close()

        expect(watched.replaceAll).not.toHaveBeenCalled()
        expect(watched.merge).not.toHaveBeenCalled()
        vi.restoreAllMocks()
        // Attachment rows are keyed by ordinal, so a stale one would reattach to the replacement.
        const reread = await readBack("tail-replace")
        expect(reread).toEqual([...history.slice(0, -1), replacement])
        expect(reread.at(-1)?.images).toBeUndefined()
    })

    it("merges instead when another handle appended after the baseline", async () => {
        const history = await seed("tail-diverged")
        const store = await UIMessage.open("tail-diverged")
        const other = await UIMessage.open("tail-diverged")
        const appended = message(HISTORY_LENGTH + 10)
        await other.append(appended)
        await other.flush()
        await other.close()
        const watched = watchWholeHistoryWrites()

        await store.updateMessage(HISTORY_LENGTH - 1, { text: "edited" })
        await store.flush()
        await store.close()

        expect(watched.merge).toHaveBeenCalledTimes(1)
        vi.restoreAllMocks()
        expect(await readBack("tail-diverged")).toEqual([
            ...history.slice(0, -1),
            { ...history[HISTORY_LENGTH - 1], text: "edited" },
            appended,
        ])
    })

    it("checks the tail again after a failed tail write instead of rewriting the history", async () => {
        const history = await seed("tail-retry")
        const store = await UIMessage.open("tail-retry")
        const watched = watchWholeHistoryWrites()
        vi.spyOn(UiMessageRowStore.prototype, "replaceTail").mockRejectedValueOnce(new Error("injected tail failure"))

        await store.updateMessage(HISTORY_LENGTH - 1, { text: "edited" })
        await expect(store.flush()).rejects.toThrow("injected tail failure")
        await store.flush()
        await store.close()

        // The row store rolls a failed tail write back, so nothing calls for the whole-history recovery.
        expect(watched.replaceAll).not.toHaveBeenCalled()
        expect(watched.merge).not.toHaveBeenCalled()
        vi.restoreAllMocks()
        expect(await readBack("tail-retry")).toEqual([
            ...history.slice(0, -1),
            { ...history[HISTORY_LENGTH - 1], text: "edited" },
        ])
    })
})

/** `database`, except that every attachment insert inside a transaction fails. */
function failingAttachmentInserts(database: TransactionalUnifyStoreDatabase): TransactionalUnifyStoreDatabase {
    return new Proxy(database, {
        get(target, property, receiver) {
            if (property !== "transaction") {
                const value = Reflect.get(target, property, receiver)
                return typeof value === "function" ? value.bind(target) : value
            }
            return <TResult>(operation: (transaction: UnifyStoreDatabaseTransaction) => TResult | Promise<TResult>) =>
                target.transaction((transaction) =>
                    operation({
                        store: <TEntity extends object>(entity: StoredEntityClass<TEntity>) => {
                            const store = transaction.store(entity)
                            if ((entity as unknown) !== UiMessageAttachmentRow) return store
                            return { ...store, insert: () => Promise.reject(new Error("injected attachment failure")) }
                        },
                    }),
                )
        },
    })
}

describe("UiMessageRowStore.replaceTail", () => {
    let docsDir: string

    beforeEach(async () => {
        docsDir = await mkdtemp(path.join(os.tmpdir(), "dline-ui-replace-tail-"))
        vi.stubEnv("DLINE_DOCS_DIR", docsDir)
    })

    afterEach(async () => {
        await closeInstanceStoragesUnder(docsDir)
        vi.unstubAllEnvs()
        await rm(docsDir, { force: true, recursive: true })
    })

    async function openRows(
        taskId: string,
        wrap: (database: TransactionalUnifyStoreDatabase) => TransactionalUnifyStoreDatabase = (database) => database,
    ): Promise<UiMessageRowStore> {
        const layout = await ensureInstanceLayout({ taskId })
        const storage = openInstanceStorage(layout.root)
        const database = await storage.openDatabase(InstanceDatabase.Messages, "ui-message-projection")
        return await UiMessageRowStore.open(wrap(database), () => storage.close())
    }

    const seeded = [message(0), message(1), message(2, { files: ["/tmp/a.txt"] })]

    async function seedRows(taskId: string): Promise<UiMessageRowStore> {
        const rows = await openRows(taskId)
        await rows.insert(seeded.map((item, ordinal) => ({ ordinal, ts: item.ts, message: item })))
        return rows
    }

    it("leaves the rows untouched when the stored tail differs from the expected one", async () => {
        const rows = await seedRows("tail-mismatch")

        const replaced = await rows.replaceTail({
            durableCount: 3,
            expectedTailTimestamps: [seeded[1].ts, seeded[2].ts + 1],
            replacedCount: 1,
            entries: [message(9)],
        })

        expect(replaced).toBe(false)
        expect((await rows.query()).records.map((record) => record.message)).toEqual(seeded)
        await rows.close()
    })

    it("rejects a tail when another writer appended after the baseline", async () => {
        const rows = await seedRows("tail-extra-row")

        const replaced = await rows.replaceTail({
            durableCount: 2,
            expectedTailTimestamps: [seeded[1].ts],
            replacedCount: 1,
            entries: [message(9)],
        })

        expect(replaced).toBe(false)
        expect((await rows.query()).records.map((record) => record.message)).toEqual(seeded)
        await rows.close()
    })

    it("replaces the tail and drops the attachments of replaced rows in one transaction", async () => {
        const rows = await seedRows("tail-replace")

        const replaced = await rows.replaceTail({
            durableCount: 3,
            expectedTailTimestamps: [seeded[1].ts, seeded[2].ts],
            replacedCount: 1,
            entries: [message(7), message(8, { images: ["data:image/png;base64,DDD"] })],
        })

        expect(replaced).toBe(true)
        const { records } = await rows.query()
        expect(records.map((record) => record.ordinal)).toEqual([0, 1, 2, 3])
        expect(records.map((record) => record.message)).toEqual([
            seeded[0],
            seeded[1],
            message(7),
            message(8, { images: ["data:image/png;base64,DDD"] }),
        ])
        await rows.close()
    })

    it("drops the rows a shorter replacement no longer covers", async () => {
        const rows = await seedRows("tail-shrink")

        const replaced = await rows.replaceTail({
            durableCount: 3,
            expectedTailTimestamps: [seeded[1].ts, seeded[2].ts],
            replacedCount: 2,
            entries: [message(7)],
        })

        expect(replaced).toBe(true)
        const { records } = await rows.query()
        expect(records.map((record) => record.ordinal)).toEqual([0, 1])
        // The dropped row's file reference must not resurface on the row now at its ordinal.
        expect(records.map((record) => record.message)).toEqual([seeded[0], message(7)])
        await rows.close()
    })

    it("replaces every row when the change starts at the first one", async () => {
        const rows = await seedRows("tail-whole")

        const replaced = await rows.replaceTail({
            durableCount: 3,
            expectedTailTimestamps: seeded.map((item) => item.ts),
            replacedCount: 3,
            entries: [message(7)],
        })

        expect(replaced).toBe(true)
        expect((await rows.query()).records.map((record) => [record.ordinal, record.message])).toEqual([[0, message(7)]])
        await rows.close()
    })

    it("leaves rows and attachments untouched when a write fails partway", async () => {
        await (await seedRows("tail-rollback")).close()
        const rows = await openRows("tail-rollback", failingAttachmentInserts)

        await expect(
            rows.replaceTail({
                durableCount: 3,
                expectedTailTimestamps: [seeded[1].ts, seeded[2].ts],
                replacedCount: 1,
                entries: [message(8, { images: ["data:image/png;base64,DDD"] })],
            }),
        ).rejects.toThrow("injected attachment failure")

        expect((await rows.query()).records.map((record) => record.message)).toEqual(seeded)
        await rows.close()
    })
})
