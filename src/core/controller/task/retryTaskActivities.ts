import { RetryTaskActivitiesRequest, RetryTaskActivitiesResponse } from "@shared/proto/dline/task"
import type { Controller } from ".."
import { getOpenedTask } from "./opened-task"

/** Retry selected retained subagent activities. */
export async function retryTaskActivities(
	controller: Controller,
	request: RetryTaskActivitiesRequest,
): Promise<RetryTaskActivitiesResponse> {
	const task = getOpenedTask(controller, request)
	if (!task || task.isReadOnly()) {
		return RetryTaskActivitiesResponse.create({ retriedActivityIds: [] })
	}
	for (const activityId of request.activityIds) {
		if (!task.activityStore.hasLiveRetryControl(activityId) && task.activityStore.isRetryable(activityId)) {
			await task.restoreSubagentActivityRetry(activityId)
		}
	}
	if (controller.task !== task || task.isReadOnly()) return RetryTaskActivitiesResponse.create({ retriedActivityIds: [] })
	const retriedActivityIds = await task.activityStore.retry(request.activityIds)
	return RetryTaskActivitiesResponse.create({ retriedActivityIds })
}
