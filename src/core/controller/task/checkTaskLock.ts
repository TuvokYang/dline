import { StringRequest } from "@shared/proto/dline/common"
import { TaskLockStatus } from "@shared/proto/dline/task"
import type { Controller } from ".."

/**
 * Checks whether the given task is locked by another instance.
 * Used by the frontend before initiating deletion to give early feedback.
 *
 * @param controller The controller instance
 * @param request StringRequest wrapping the task ID
 * @returns TaskLockStatus proto message
 */
export async function checkTaskLock(controller: Controller, request: StringRequest): Promise<TaskLockStatus> {
    const taskId = request.value
    if (!taskId) {
        throw new Error("Missing task ID")
    }

    const status = await controller.lockService.checkTaskLock(taskId)

    return TaskLockStatus.create({
        isLocked: status.isLocked,
        lockedBy: status.lockedBy ?? "",
        lockedAt: status.lockedAt ?? 0,
        isStale: status.isStale,
    })
}
