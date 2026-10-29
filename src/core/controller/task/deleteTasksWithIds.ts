import { StringArrayRequest } from "@shared/proto/dline/common"
import { TaskDeletionResult } from "@shared/proto/dline/task"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."
import { TaskDeletionOrchestrator } from "./TaskDeletionOrchestrator"

/**
 * Deletes tasks with the specified IDs.
 * Each task is processed independently – a single failure does not block the rest.
 *
 * @param controller The controller instance
 * @param request The request containing an array of task IDs to delete
 * @returns TaskDeletionResult with per-category counts and failed/locked ID lists
 */
export async function deleteTasksWithIds(controller: Controller, request: StringArrayRequest): Promise<TaskDeletionResult> {
    if (!request.value || request.value.length === 0) {
        throw new Error("Missing task IDs")
    }

    const taskCount = request.value.length
    const orchestrator = new TaskDeletionOrchestrator(controller, controller.lockService)
    const result = await orchestrator.deleteBatch(request.value)

    await controller.postStateToWebview()

    if (result.failed > 0) {
        Logger.warn(`[deleteTasksWithIds] ${result.failed} task(s) failed: ${result.failedIds.join(", ")}`)
    }
    if (result.skippedLocked > 0) {
        Logger.warn(`[deleteTasksWithIds] ${result.skippedLocked} task(s) skipped (locked): ${result.lockedIds.join(", ")}`)
    }

    return TaskDeletionResult.create({
        totalRequested: result.totalRequested,
        deleted: result.deleted,
        failed: result.failed,
        skippedLocked: result.skippedLocked,
        failedIds: result.failedIds,
        lockedIds: result.lockedIds,
    })
}
