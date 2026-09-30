import { CancelTaskActivitiesRequest, CancelTaskActivitiesResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."
import { getOpenedTask } from "./opened-task"

/** Cancel only the requested task-local activities. */
export async function cancelTaskActivities(
	controller: Controller,
	request: CancelTaskActivitiesRequest,
): Promise<CancelTaskActivitiesResponse> {
	const task = getOpenedTask(controller, request)
	if (!task || task.isReadOnly()) {
		return CancelTaskActivitiesResponse.create({ cancelledActivityIds: [] })
	}
	const cancelledActivityIds = await task.activityStore.cancel(request.activityIds)
	return CancelTaskActivitiesResponse.create({ cancelledActivityIds })
}
