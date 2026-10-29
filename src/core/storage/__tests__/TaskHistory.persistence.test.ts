import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { HistoryItem } from "@shared/HistoryItem"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openTaskHistory, type TaskHistory } from "../TaskHistory"

function item(overrides: Partial<HistoryItem> = {}): HistoryItem {
    return {
        id: "task-1",
        task: "Persist the newest revision",
        ts: 100,
        tokensIn: 10,
        tokensOut: 20,
        totalCost: 1,
        ...overrides,
    }
}

/**
 * Durability is only observable across store instances.
 *
 * A single instance answers from memory, which is exactly why the original
 * defect stayed invisible while the app was running and only surfaced after a
 * restart. Every assertion here therefore reopens the store.
 */
describe("TaskHistory durable identity", () => {
    let tempDir: string
    let databasePath: string
    let history: TaskHistory

    async function reopen(): Promise<TaskHistory> {
        await history.dispose()
        history = await openTaskHistory(databasePath)
        return history
    }

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "dline-task-history-persistence-"))
        databasePath = path.join(tempDir, "taskHistory.db")
        history = await openTaskHistory(databasePath)
    })

    afterEach(async () => {
        await history.dispose()
        await rm(tempDir, { recursive: true, force: true })
    })

    it("serves the most recent write after the store is reopened", async () => {
        await history.upsertTaskHistory(item({ ts: 100, tokensIn: 10 }))
        await history.upsertTaskHistory(item({ ts: 200, tokensIn: 99, totalCost: 4.5 }))
        await history.flush()

        const reopened = await reopen()

        await expect(reopened.getDeduplicated()).resolves.toEqual([
            expect.objectContaining({ id: "task-1", ts: 200, tokensIn: 99, totalCost: 4.5 }),
        ])
    })

    it("keeps exactly one durable record per task id", async () => {
        for (const ts of [100, 200, 300]) {
            await history.upsertTaskHistory(item({ ts, tokensIn: ts }))
        }
        await history.flush()

        const reopened = await reopen()

        await expect(reopened.getDeduplicated()).resolves.toHaveLength(1)
    })

    it("preserves the completion projection across a reopen", async () => {
        await history.upsertTaskHistory(item({ ts: 100 }))
        await history.setCompletionState({ taskId: "task-1", isCompleted: true, revision: 7 })
        // An ordinary metadata update must not retract a completion already recorded.
        await history.upsertTaskHistory(item({ ts: 200, tokensIn: 99 }))
        await history.flush()

        const reopened = await reopen()

        await expect(reopened.getById("task-1")).resolves.toMatchObject({
            isCompleted: true,
            completionStateRevision: 7,
            tokensIn: 99,
        })
    })

    it("resolves getById to the same record getDeduplicated reports", async () => {
        await history.upsertTaskHistory(item({ ts: 100, tokensIn: 10 }))
        await history.upsertTaskHistory(item({ ts: 200, tokensIn: 99 }))
        await history.flush()

        const reopened = await reopen()
        const [listed] = await reopened.getDeduplicated()

        await expect(reopened.getById("task-1")).resolves.toEqual(listed)
    })

    it("removes a deleted task from durable storage", async () => {
        await history.upsertTaskHistory(item({ id: "task-1" }))
        await history.upsertTaskHistory(item({ id: "task-2", ts: 300 }))
        await history.flush()

        await history.softDelete("task-1")
        const reopened = await reopen()

        await expect(reopened.getById("task-1")).resolves.toBeUndefined()
        await expect(reopened.getDeduplicated()).resolves.toEqual([expect.objectContaining({ id: "task-2" })])
    })

    it("retains only favorited tasks when deleting all except favorites", async () => {
        await history.upsertTaskHistory(item({ id: "keep", ts: 100, isFavorited: true }))
        await history.upsertTaskHistory(item({ id: "drop", ts: 200, isFavorited: false }))
        await history.flush()

        await expect(history.deleteAllExceptFavorites()).resolves.toBe(1)
        const reopened = await reopen()

        await expect(reopened.getDeduplicated()).resolves.toEqual([expect.objectContaining({ id: "keep" })])
    })

    it("clears every task", async () => {
        await history.upsertTaskHistory(item({ id: "task-1" }))
        await history.upsertTaskHistory(item({ id: "task-2", ts: 300 }))
        await history.flush()

        await history.clearAll()
        const reopened = await reopen()

        await expect(reopened.getDeduplicated()).resolves.toEqual([])
    })

    it("reports the newest task first", async () => {
        await history.upsertTaskHistory(item({ id: "older", ts: 100 }))
        await history.upsertTaskHistory(item({ id: "newer", ts: 300 }))
        await history.flush()

        const reopened = await reopen()

        await expect(reopened.getDeduplicated()).resolves.toEqual([
            expect.objectContaining({ id: "newer" }),
            expect.objectContaining({ id: "older" }),
        ])
    })
})
