import { Controller } from "@core/controller"
import { clearWorkspaceHistoryManagersForTests } from "@core/controller/history/WorkspaceHistoryManager"
import type { HistoryItem } from "@shared/HistoryItem"
import Mutex from "p-mutex"
import { beforeEach, describe, expect, it, vi } from "vitest"

function item(overrides: Partial<HistoryItem> = {}): HistoryItem {
    return {
        id: "task-1",
        task: "Task",
        ts: 100,
        tokensIn: 1,
        tokensOut: 2,
        totalCost: 3,
        ...overrides,
    }
}

function fakeController(history: HistoryItem[], completionResult?: HistoryItem) {
    let cache = history
    const setGlobalState = vi.fn((_key: string, value: HistoryItem[]) => {
        cache = value
    })
    const stateManager = {
        taskHistory: {
            // The durable store owns the completion projection and returns the row it staged.
            upsertTaskHistory: vi.fn(async (staged: HistoryItem): Promise<HistoryItem> => staged),
            setCompletionState: vi.fn(async () => completionResult),
        },
        getGlobalStateKey: vi.fn(() => cache),
        setGlobalState,
    }
    const controller = Object.create(Controller.prototype) as Controller
    Object.assign(controller as unknown as Record<string, unknown>, {
        stateManager,
        workspaceManager: { getPrimaryRoot: () => ({ path: "test-workspace" }) },
        taskHistoryProjectionMutex: new Mutex(),
    })
    return { controller, stateManager, getCache: () => cache }
}

describe("Controller task history completion projection", () => {
    beforeEach(() => {
        clearWorkspaceHistoryManagersForTests()
    })
    it("rejects History publication before a workspace path is initialized", async () => {
        const controller = Object.create(Controller.prototype) as Controller
        Object.assign(controller as unknown as Record<string, unknown>, {
            stateManager: {
                taskHistory: {},
                getGlobalStateKey: vi.fn(() => []),
                setGlobalState: vi.fn(),
            },
        })

        await expect(controller.updateTaskHistory(item())).rejects.toThrow(
            "WorkspaceHistoryManager requires an initialized workspace path",
        )
    })

    it("preserves a newer completion projection during ordinary metadata updates", async () => {
        const current = item({ isCompleted: true, completionStateRevision: 7, isFavorited: true })
        const { controller, stateManager, getCache } = fakeController([current])
        const metadata = item({ tokensIn: 50, totalCost: 9 })

        await controller.updateTaskHistory(metadata)

        expect(stateManager.taskHistory.upsertTaskHistory).toHaveBeenCalledWith(
            expect.objectContaining({
                id: "task-1",
                tokensIn: 50,
                totalCost: 9,
                isCompleted: true,
                completionStateRevision: 7,
            }),
        )
        expect(getCache()[0]).toMatchObject({ isCompleted: true, completionStateRevision: 7, tokensIn: 50 })
    })

    it("rejects completion fields supplied by ordinary metadata updates", async () => {
        const current = item({ isCompleted: true, completionStateRevision: 7 })
        const { controller, stateManager, getCache } = fakeController([current])

        await controller.updateTaskHistory(item({ isCompleted: false, completionStateRevision: 99, tokensIn: 50 }))

        expect(stateManager.taskHistory.upsertTaskHistory).toHaveBeenCalledWith(
            expect.objectContaining({ isCompleted: true, completionStateRevision: 7, tokensIn: 50 }),
        )
        expect(getCache()[0]).toMatchObject({ isCompleted: true, completionStateRevision: 7, tokensIn: 50 })
    })

    it("accepts completion while metadata persistence continues in the manager queue", async () => {
        let releaseMetadata!: () => void
        const metadataRelease = new Promise<void>((resolve) => {
            releaseMetadata = resolve
        })
        const updated = item({ isCompleted: false, completionStateRevision: 8, tokensIn: 50 })
        const { controller, stateManager, getCache } = fakeController(
            [item({ isCompleted: true, completionStateRevision: 7 })],
            updated,
        )
        stateManager.taskHistory.upsertTaskHistory.mockImplementationOnce(async (staged: HistoryItem) => {
            await metadataRelease
            return staged
        })

        const metadataUpdate = controller.updateTaskHistory(item({ tokensIn: 50 }))
        await vi.waitFor(() => expect(stateManager.taskHistory.upsertTaskHistory).toHaveBeenCalledOnce())
        await expect(controller.persistTaskCompletionState("task-1", false, 8)).resolves.toBe(true)

        expect(stateManager.taskHistory.setCompletionState).not.toHaveBeenCalled()
        expect(getCache()).toEqual([updated])
        releaseMetadata()
        await metadataUpdate
        await vi.waitFor(() => expect(stateManager.taskHistory.setCompletionState).toHaveBeenCalledOnce())
    })

    it("durably patches completion and synchronizes the controller cache", async () => {
        const updated = item({ isCompleted: false, completionStateRevision: 8, isFavorited: true })
        const { controller, stateManager, getCache } = fakeController(
            [item({ isCompleted: true, completionStateRevision: 7, isFavorited: true })],
            updated,
        )

        await expect(controller.persistTaskCompletionState("task-1", false, 8)).resolves.toBe(true)
        await vi.waitFor(() =>
            expect(stateManager.taskHistory.setCompletionState).toHaveBeenCalledWith({
                taskId: "task-1",
                isCompleted: false,
                revision: 8,
            }),
        )
        expect(getCache()).toEqual([updated])
    })

    it("does not rewrite cache when the durable store rejects an unchanged or stale projection", async () => {
        const current = item({ isCompleted: true, completionStateRevision: 7 })
        const { controller, stateManager, getCache } = fakeController([current], undefined)

        await expect(controller.persistTaskCompletionState("task-1", true, 7)).resolves.toBe(false)
        expect(stateManager.setGlobalState).not.toHaveBeenCalled()
        expect(getCache()).toEqual([current])
    })
})
