import { Empty, StringRequest } from "@shared/proto/dline/common"
import type { Controller } from ".."

/**
 * Force-release the lock on a task so the current instance can take over.
 *
 * Releasing is all this request does. Re-acquisition and the read-only to
 * interactive transition are scheduled to run after the response is sent:
 * performing them inline writes a new lock file while the caller still
 * treats the unlock as in progress, and that new lock is what made the
 * unlock itself look like it had failed.
 *
 * @param controller The controller instance
 * @param request StringRequest wrapping the task ID
 * @returns Empty
 */
export async function forceReleaseTaskLock(controller: Controller, request: StringRequest): Promise<Empty> {
    const taskId = request.value
    if (!taskId) {
        throw new Error("Missing task ID")
    }

    // Release only. The caller's unlock modal closes on this response.
    await controller.lockService.forceReleaseTaskLock(taskId)

    // Take the task over once the unlock itself has been answered.
    controller.scheduleTakeoverAfterUnlock(taskId)

    return Empty.create()
}
