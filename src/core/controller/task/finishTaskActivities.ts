import { FinishTaskActivitiesRequest, FinishTaskActivitiesResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."
import { getOpenedTask } from "./opened-task"

/** Request soft completion for selected running subagent activities. */
export async function finishTaskActivities(
	controller: Controller,
	request: FinishTaskActivitiesRequest,
): Promise<FinishTaskActivitiesResponse> {
	const task = getOpenedTask(controller, request)
	if (!task || task.isReadOnly()) {
		return FinishTaskActivitiesResponse.create({ finishedActivityIds: [] })
	}
	const finishedActivityIds = await task.activityStore.finish(request.activityIds)
	return FinishTaskActivitiesResponse.create({ finishedActivityIds })
}
