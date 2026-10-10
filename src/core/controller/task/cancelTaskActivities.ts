import { CancelTaskActivitiesRequest, CancelTaskActivitiesResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."
import { currentOpening } from "./opened-task"

/** Cancel only the requested task-local activities. */
export async function cancelTaskActivities(
    controller: Controller,
    request: CancelTaskActivitiesRequest,
): Promise<CancelTaskActivitiesResponse> {
    // Only the running session the request was opened against owns live activities.
    const task = controller.task
    // A window that does not own the task has no live activities to control.
    if (!task || currentOpening(controller, request) !== task || !task.writable) {
        return CancelTaskActivitiesResponse.create({ cancelledActivityIds: [] })
    }
    const cancelledActivityIds = await task.owners.activities.cancel(request.activityIds)
    return CancelTaskActivitiesResponse.create({ cancelledActivityIds })
}
