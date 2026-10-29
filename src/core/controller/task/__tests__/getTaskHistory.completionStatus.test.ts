import type { Controller } from "@core/controller"
import { getTaskHistory } from "@core/controller/task/getTaskHistory"
import type { HistoryItem } from "@shared/HistoryItem"
import { GetTaskHistoryRequest } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"

function historyItem(id: string, ts: number, overrides: Partial<HistoryItem> = {}): HistoryItem {
    return {
        id,
        task: `Task ${id}`,
        ts,
        tokensIn: 0,
        tokensOut: 0,
        totalCost: 0,
        ...overrides,
    }
}

function controllerFor(history: HistoryItem[]): Controller {
    return {
        stateManager: {
            getGlobalStateKey: vi.fn(() => history),
        },
        updateTaskHistory: vi.fn(async () => history),
    } as unknown as Controller
}

describe("getTaskHistory completion status", () => {
    it("treats legacy completion booleans without a runtime revision as incomplete", async () => {
        const response = await getTaskHistory(
            controllerFor([historyItem("legacy", 1, { isCompleted: true })]),
            GetTaskHistoryRequest.create({ includeCompletionStatus: true }),
        )

        expect(response.tasks).toEqual([expect.objectContaining({ id: "legacy", isCompleted: false })])
    })

    it("returns true only for a revisioned canonical completion projection", async () => {
        const response = await getTaskHistory(
            controllerFor([
                historyItem("completed", 2, { isCompleted: true, completionStateRevision: 7 }),
                historyItem("running", 1, { isCompleted: false, completionStateRevision: 8 }),
            ]),
            GetTaskHistoryRequest.create({ includeCompletionStatus: true }),
        )

        expect(response.tasks).toEqual([
            expect.objectContaining({ id: "completed", isCompleted: true }),
            expect.objectContaining({ id: "running", isCompleted: false }),
        ])
    })

    it("keeps Recent filtering and sorting as an in-memory operation", async () => {
        const controller = controllerFor([
            historyItem("newest", 3, { isCompleted: true, completionStateRevision: 3 }),
            historyItem("older", 2, { isCompleted: true }),
            historyItem("oldest", 1, { isCompleted: false, completionStateRevision: 4 }),
        ])

        const response = await getTaskHistory(
            controller,
            GetTaskHistoryRequest.create({ includeCompletionStatus: true, resultLimit: 2, sortBy: "newest" }),
        )

        expect(response.totalCount).toBe(3)
        expect(response.tasks).toEqual([
            expect.objectContaining({ id: "newest", isCompleted: true }),
            expect.objectContaining({ id: "older", isCompleted: false }),
        ])
        expect(controller.updateTaskHistory).not.toHaveBeenCalled()
    })
})
