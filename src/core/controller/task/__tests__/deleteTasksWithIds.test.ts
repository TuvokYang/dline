import { StringArrayRequest } from "@shared/proto/dline/common"
import { describe, expect, it, vi } from "vitest"
import { deleteTasksWithIds } from "../deleteTasksWithIds"

/**
 * Build a controller fixture for task deletion tests.
 * @returns Controller-like fixture with deletion dependencies.
 */
function buildController() {
    return {
        deleteTaskFromState: vi.fn().mockResolvedValue([]),
        getTaskWithId: vi.fn().mockRejectedValue(new Error("Task not found")),
        lockService: {
            checkTaskLock: vi.fn().mockResolvedValue({ isLocked: false, isStale: false }),
        },
        postStateToWebview: vi.fn().mockResolvedValue(undefined),
        task: undefined,
    }
}

describe("deleteTasksWithIds", () => {
    it("deletes without native host confirmation because webview already confirmed", async () => {
        const controller = buildController()

        const result = await deleteTasksWithIds(
            controller as never,
            StringArrayRequest.create({ value: ["task-with-webview-confirm"] }),
        )

        expect(result.totalRequested).toBe(1)
        expect(result.deleted).toBe(1)
        expect(result.failed).toBe(0)
        expect(result.skippedLocked).toBe(0)
        expect(controller.postStateToWebview).toHaveBeenCalledOnce()
    })
})
