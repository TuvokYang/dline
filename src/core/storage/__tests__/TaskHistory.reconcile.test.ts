import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { HistoryItem } from "@shared/HistoryItem"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openTaskHistory, type TaskHistory } from "../TaskHistory"

function item(id: string, overrides: Partial<HistoryItem> = {}): HistoryItem {
    return { id, task: `task ${id}`, ts: Number(id), tokensIn: 1, tokensOut: 1, totalCost: 0, ...overrides }
}

describe("TaskHistory.reconcile", () => {
    let tempDir: string
    let history: TaskHistory

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "dline-task-history-reconcile-"))
        history = await openTaskHistory(path.join(tempDir, "taskHistory.db"))
    })

    afterEach(async () => {
        await history.dispose()
        await rm(tempDir, { recursive: true, force: true })
    })

    it("keeps the workspace, favorite and completion state of entries whose folder still exists", async () => {
        await history.upsert(item("100", { cwdOnTaskInitialization: "/work/a", isFavorited: true }))
        await history.setCompletionState({ taskId: "100", isCompleted: true, revision: 3 })

        const rebuilt = await history.reconcile({ removedTaskIds: new Set(), addedItems: [] })

        expect(rebuilt).toEqual([
            expect.objectContaining({
                id: "100",
                cwdOnTaskInitialization: "/work/a",
                isFavorited: true,
                isCompleted: true,
                completionStateRevision: 3,
            }),
        ])
        await expect(history.getById("100")).resolves.toMatchObject({ isCompleted: true, completionStateRevision: 3 })
    })

    it("drops only entries found without a folder and adds the rebuilt ones, newest first", async () => {
        await history.upsert(item("100"))
        await history.upsert(item("200"))

        const rebuilt = await history.reconcile({
            removedTaskIds: new Set(["100"]),
            addedItems: [item("300", { cwdOnTaskInitialization: "/work/b" })],
        })

        expect(rebuilt.map((entry) => entry.id)).toEqual(["300", "200"])
        expect((await history.getDeduplicated()).map((entry) => entry.id)).toEqual(["300", "200"])
        await expect(history.getById("300")).resolves.toMatchObject({ cwdOnTaskInitialization: "/work/b" })
    })

    it("never lets a rebuilt entry replace a row written since the scan", async () => {
        // Another window wrote this task after the rebuild scanned the index.
        await history.upsert(item("400", { cwdOnTaskInitialization: "/work/live", modelId: "live-model" }))

        await history.reconcile({ removedTaskIds: new Set(), addedItems: [item("400", { task: "rebuilt from disk" })] })

        await expect(history.getById("400")).resolves.toMatchObject({
            task: "task 400",
            cwdOnTaskInitialization: "/work/live",
            modelId: "live-model",
        })
    })
})
