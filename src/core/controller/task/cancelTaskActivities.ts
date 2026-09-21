import { CancelTaskActivitiesRequest, CancelTaskActivitiesResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."

/** Cancel only the requested task-local activities. */
export async function cancelTaskActivities(
	controller: Controller,
	request: CancelTaskActivitiesRequest,
): Promise<CancelTaskActivitiesResponse> {
	const task = controller.task
	if (!task || task.taskId !== request.taskId) {
		return CancelTaskActivitiesResponse.create({ cancelledActivityIds: [] })
	}
	const cancelledActivityIds = await task.owners.activities.cancel(request.activityIds)
	return CancelTaskActivitiesResponse.create({ cancelledActivityIds })
}
