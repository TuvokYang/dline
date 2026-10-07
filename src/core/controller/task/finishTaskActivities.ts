import { FinishTaskActivitiesRequest, FinishTaskActivitiesResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."
import { currentOpening } from "./opened-task"

/** Request soft completion for selected running subagent activities. */
export async function finishTaskActivities(
	controller: Controller,
	request: FinishTaskActivitiesRequest,
): Promise<FinishTaskActivitiesResponse> {
	// Only the running session the request was opened against owns live activities.
	const task = controller.task
	if (!task || currentOpening(controller, request) !== task) {
		return FinishTaskActivitiesResponse.create({ finishedActivityIds: [] })
	}
	const finishedActivityIds = await task.owners.activities.finish(request.activityIds)
	return FinishTaskActivitiesResponse.create({ finishedActivityIds })
}
