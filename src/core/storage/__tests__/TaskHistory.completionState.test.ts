import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { HistoryItem } from "@shared/HistoryItem"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { openTaskHistory, type TaskHistory } from "../TaskHistory"

function item(overrides: Partial<HistoryItem> = {}): HistoryItem {
    return {
        id: "task-1",
        task: "Keep metadata intact",
        ts: 100,
        tokensIn: 11,
        tokensOut: 12,
        totalCost: 1.25,
        isFavorited: true,
        modelId: "model-1",
        ...overrides,
    }
}

describe("TaskHistory completion state", () => {
    let tempDir: string
    let databasePath: string
    let history: TaskHistory

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "dline-task-history-completion-"))
        databasePath = path.join(tempDir, "taskHistory.db")
        history = await openTaskHistory(databasePath)
        await history.upsert(item())
    })

    afterEach(async () => {
        await history.dispose()
        await rm(tempDir, { recursive: true, force: true })
    })

    it("durably patches completion without overwriting unrelated metadata", async () => {
        const updated = await history.setCompletionState({ taskId: "task-1", isCompleted: true, revision: 7 })

        expect(updated).toMatchObject({
            id: "task-1",
            isCompleted: true,
            completionStateRevision: 7,
            isFavorited: true,
            totalCost: 1.25,
            modelId: "model-1",
            tokensIn: 11,
            tokensOut: 12,
        })
        await expect(history.getDeduplicated()).resolves.toEqual([
            expect.objectContaining({ isCompleted: true, completionStateRevision: 7 }),
        ])
    })

    it("rejects stale or conflicting equal revisions without rewriting the current projection", async () => {
        await history.setCompletionState({ taskId: "task-1", isCompleted: true, revision: 7 })

        await expect(history.setCompletionState({ taskId: "task-1", isCompleted: false, revision: 7 })).resolves.toBeUndefined()
        await expect(history.setCompletionState({ taskId: "task-1", isCompleted: false, revision: 6 })).resolves.toBeUndefined()
        await expect(history.getById("task-1")).resolves.toMatchObject({
            isCompleted: true,
            completionStateRevision: 7,
        })
    })

    it("persists a later true to false transition", async () => {
        await history.setCompletionState({ taskId: "task-1", isCompleted: true, revision: 7 })

        await expect(history.setCompletionState({ taskId: "task-1", isCompleted: false, revision: 8 })).resolves.toMatchObject({
            isCompleted: false,
            completionStateRevision: 8,
        })
        await expect(history.getById("task-1")).resolves.toMatchObject({
            isCompleted: false,
            completionStateRevision: 8,
        })
    })

    it("preserves a newer completion projection during metadata updates", async () => {
        await history.setCompletionState({ taskId: "task-1", isCompleted: true, revision: 7 })

        await history.upsertTaskHistory(item({ isCompleted: false, completionStateRevision: 99, tokensIn: 99, totalCost: 4.5 }))
        await history.flush()

        await expect(history.getById("task-1")).resolves.toMatchObject({
            isCompleted: true,
            completionStateRevision: 7,
            tokensIn: 99,
            totalCost: 4.5,
        })
    })

    it("does not establish a completion projection through an ordinary upsert", async () => {
        await history.upsert(item({ isCompleted: true, completionStateRevision: 99 }))

        await expect(history.getById("task-1")).resolves.not.toHaveProperty("isCompleted")
        await expect(history.getById("task-1")).resolves.not.toHaveProperty("completionStateRevision")
    })

    it("does not rewrite an unchanged completion value", async () => {
        await history.setCompletionState({ taskId: "task-1", isCompleted: true, revision: 7 })

        await expect(history.setCompletionState({ taskId: "task-1", isCompleted: true, revision: 8 })).resolves.toBeUndefined()
        await expect(history.getById("task-1")).resolves.toMatchObject({
            isCompleted: true,
            completionStateRevision: 7,
        })
    })

    it("applies many projections in one batch and skips the stale ones", async () => {
        await history.upsert(item({ id: "task-2", ts: 200 }))
        await history.setCompletionState({ taskId: "task-2", isCompleted: true, revision: 4 })

        const applied = await history.setCompletionStates([
            { taskId: "task-1", isCompleted: true, revision: 1 },
            { taskId: "task-2", isCompleted: true, revision: 9 },
            { taskId: "missing", isCompleted: true, revision: 1 },
        ])

        expect(applied).toEqual([expect.objectContaining({ id: "task-1", isCompleted: true, completionStateRevision: 1 })])
        await expect(history.getById("task-2")).resolves.toMatchObject({ isCompleted: true, completionStateRevision: 4 })
    })
})
