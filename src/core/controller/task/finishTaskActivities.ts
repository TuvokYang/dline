import { FinishTaskActivitiesRequest, FinishTaskActivitiesResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."

/** Request soft completion for selected running subagent activities. */
export async function finishTaskActivities(
	controller: Controller,
	request: FinishTaskActivitiesRequest,
): Promise<FinishTaskActivitiesResponse> {
	const task = controller.task
	if (!task || task.taskId !== request.taskId) {
		return FinishTaskActivitiesResponse.create({ finishedActivityIds: [] })
	}
	const finishedActivityIds = await task.owners.activities.finish(request.activityIds)
	return FinishTaskActivitiesResponse.create({ finishedActivityIds })
}
