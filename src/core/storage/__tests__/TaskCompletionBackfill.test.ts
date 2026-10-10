import type { HistoryItem } from "@shared/HistoryItem"
import { describe, expect, it, vi } from "vitest"
import {
    type CompletionRepair,
    type RecoveredCompletion,
    TASK_COMPLETION_BACKFILL_GENERATION,
    TaskCompletionBackfill,
} from "../TaskCompletionBackfill"

type PersistBatchFn = (updates: readonly CompletionRepair[]) => Promise<number>

function item(id: string, overrides: Partial<HistoryItem> = {}): HistoryItem {
    return { id, task: `Task ${id}`, ts: 100, tokensIn: 0, tokensOut: 0, totalCost: 0, ...overrides }
}

function backfill(options: {
    tasks: HistoryItem[]
    completions: Record<string, RecoveredCompletion | undefined>
    persistBatch?: ReturnType<typeof vi.fn<PersistBatchFn>>
    onRepaired?: ReturnType<typeof vi.fn<(repairedCount: number) => void>>
}) {
    const persistBatch = options.persistBatch ?? vi.fn<PersistBatchFn>(async (updates) => updates.length)
    return {
        persistBatch,
        runner: new TaskCompletionBackfill({
            listTasks: async () => options.tasks,
            readCompletion: async (taskId) => options.completions[taskId],
            persistBatch,
            onRepaired: options.onRepaired,
            yieldBetweenChunks: async () => undefined,
        }),
    }
}

describe("TASK_COMPLETION_BACKFILL_GENERATION", () => {
    it("advances past the generation that only repaired lost projections", () => {
        // Histories already marked as repaired under generation 1 still carry
        // projections retracted by the close-task defect, so the scan must run
        // again for them.
        expect(TASK_COMPLETION_BACKFILL_GENERATION).toBeGreaterThan(1)
        expect(Number.isSafeInteger(TASK_COMPLETION_BACKFILL_GENERATION)).toBe(true)
    })
})

describe("TaskCompletionBackfill", () => {
    it("repairs a completed task whose projection was cleared", async () => {
        const { runner, persistBatch } = backfill({
            tasks: [item("task-1", { isCompleted: false, completionStateRevision: 87 })],
            completions: { "task-1": { isCompleted: true } },
        })

        await expect(runner.run()).resolves.toEqual({ scanned: 1, repaired: 1, failed: 0 })
        // The revision must clear the stored watermark or the store rejects it.
        expect(persistBatch).toHaveBeenCalledExactlyOnceWith([{ taskId: "task-1", isCompleted: true, revision: 88 }])
    })

    it("establishes a missing projection for a completed task", async () => {
        const { runner, persistBatch } = backfill({
            tasks: [item("task-1")],
            completions: { "task-1": { isCompleted: true } },
        })

        await expect(runner.run()).resolves.toMatchObject({ repaired: 1 })
        expect(persistBatch).toHaveBeenCalledExactlyOnceWith([{ taskId: "task-1", isCompleted: true, revision: 1 }])
    })

    it("commits all repairs through one batch transaction", async () => {
        const { runner, persistBatch } = backfill({
            tasks: [item("task-1"), item("task-2", { isCompleted: false, completionStateRevision: 3 })],
            completions: { "task-1": { isCompleted: true }, "task-2": { isCompleted: true } },
        })

        await expect(runner.run()).resolves.toEqual({ scanned: 2, repaired: 2, failed: 0 })
        expect(persistBatch).toHaveBeenCalledExactlyOnceWith([
            { taskId: "task-1", isCompleted: true, revision: 1 },
            { taskId: "task-2", isCompleted: true, revision: 4 },
        ])
    })

    it("leaves an already correct projection untouched", async () => {
        const { runner, persistBatch } = backfill({
            tasks: [item("task-1", { isCompleted: true, completionStateRevision: 5 })],
            completions: { "task-1": { isCompleted: true } },
        })

        await expect(runner.run()).resolves.toEqual({ scanned: 1, repaired: 0, failed: 0 })
        expect(persistBatch).not.toHaveBeenCalled()
    })

    it("never invents a verdict for a task without a readable snapshot", async () => {
        const { runner, persistBatch } = backfill({
            tasks: [item("task-1", { isCompleted: true, completionStateRevision: 5 }), item("task-2")],
            completions: {},
        })

        await expect(runner.run()).resolves.toEqual({ scanned: 2, repaired: 0, failed: 0 })
        expect(persistBatch).not.toHaveBeenCalled()
    })

    it("counts rows rejected by the durable batch as unrepaired", async () => {
        const { runner } = backfill({
            tasks: [item("task-1")],
            completions: { "task-1": { isCompleted: true } },
            persistBatch: vi.fn<PersistBatchFn>(async () => 0),
        })

        await expect(runner.run()).resolves.toEqual({ scanned: 1, repaired: 0, failed: 0 })
    })

    it("continues past one unreadable task and reports it as failed", async () => {
        const persistBatch = vi.fn<PersistBatchFn>(async (updates) => updates.length)
        const runner = new TaskCompletionBackfill({
            listTasks: async () => [item("broken"), item("task-2")],
            readCompletion: async (taskId) => {
                if (taskId === "broken") throw new Error("snapshot unreadable")
                return { isCompleted: true }
            },
            persistBatch,
            yieldBetweenChunks: async () => undefined,
        })

        await expect(runner.run()).resolves.toEqual({ scanned: 2, repaired: 1, failed: 1 })
        expect(persistBatch).toHaveBeenCalledExactlyOnceWith([{ taskId: "task-2", isCompleted: true, revision: 1 }])
    })

    it("notifies once with the repaired count so views can refresh", async () => {
        const onRepaired = vi.fn<(repairedCount: number) => void>()
        const { runner } = backfill({
            tasks: [item("task-1"), item("task-2")],
            completions: { "task-1": { isCompleted: true }, "task-2": { isCompleted: true } },
            onRepaired,
        })

        await runner.run()

        expect(onRepaired).toHaveBeenCalledExactlyOnceWith(2)
    })

    it("does not notify when nothing changed", async () => {
        const onRepaired = vi.fn<(repairedCount: number) => void>()
        const { runner } = backfill({
            tasks: [item("task-1", { isCompleted: true, completionStateRevision: 2 })],
            completions: { "task-1": { isCompleted: true } },
            onRepaired,
        })

        await runner.run()

        expect(onRepaired).not.toHaveBeenCalled()
    })

    it("yields between chunks so a long history cannot block the event loop", async () => {
        const yieldBetweenChunks = vi.fn(async () => undefined)
        const runner = new TaskCompletionBackfill({
            listTasks: async () => Array.from({ length: 60 }, (_, index) => item(`task-${index}`)),
            readCompletion: async () => undefined,
            persistBatch: vi.fn<PersistBatchFn>(async (updates) => updates.length),
            yieldBetweenChunks,
        })

        await expect(runner.run()).resolves.toMatchObject({ scanned: 60 })
        expect(yieldBetweenChunks).toHaveBeenCalledTimes(2)
    })
})
