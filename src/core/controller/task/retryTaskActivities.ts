import { RetryTaskActivitiesRequest, RetryTaskActivitiesResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."

/** Retry selected retained subagent activities. */
export async function retryTaskActivities(
	controller: Controller,
	request: RetryTaskActivitiesRequest,
): Promise<RetryTaskActivitiesResponse> {
	const task = controller.task
	if (!task || task.taskId !== request.taskId) {
		return RetryTaskActivitiesResponse.create({ retriedActivityIds: [] })
	}
	for (const activityId of request.activityIds) {
		if (!task.owners.activities.hasLiveRetryControl(activityId) && task.owners.activities.isRetryable(activityId)) {
			await task.owners.toolExecution.restoreSubagentActivityRetry(activityId)
		}
	}
	const retriedActivityIds = await task.owners.activities.retry(request.activityIds)
	return RetryTaskActivitiesResponse.create({ retriedActivityIds })
}
