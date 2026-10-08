import { RetryTaskActivitiesRequest, RetryTaskActivitiesResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."
import { currentOpening } from "./opened-task"

/** Retry selected retained subagent activities. */
export async function retryTaskActivities(
	controller: Controller,
	request: RetryTaskActivitiesRequest,
): Promise<RetryTaskActivitiesResponse> {
	// Only the surface the request was opened against may retry; a stale one is ignored.
	if (!currentOpening(controller, request)) return RetryTaskActivitiesResponse.create({ retriedActivityIds: [] })
	// Retry offered on a history surface first makes that task the runtime.
	if (
		controller.task?.taskId !== request.taskId &&
		!(await controller.promoteHistoryDisplayForActivityControl(request.taskId))
	) {
		return RetryTaskActivitiesResponse.create({ retriedActivityIds: [] })
	}
	const task = controller.task
	// A retry restarts work, which only the window owning the task may do.
	if (!task || task.taskId !== request.taskId || !task.writable) {
		return RetryTaskActivitiesResponse.create({ retriedActivityIds: [] })
	}
	for (const activityId of request.activityIds) {
		if (!task.owners.activities.hasLiveRetryControl(activityId) && task.owners.activities.isRetryable(activityId)) {
			await task.owners.toolExecution.restoreSubagentActivityRetry(activityId)
		}
	}
	if (controller.task !== task) return RetryTaskActivitiesResponse.create({ retriedActivityIds: [] })
	const retriedActivityIds = await task.owners.activities.retry(request.activityIds)
	return RetryTaskActivitiesResponse.create({ retriedActivityIds })
}
