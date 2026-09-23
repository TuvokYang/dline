import {
	TaskActivity as ProtoTaskActivity,
	TaskActivityEvent as ProtoTaskActivityEvent,
	TaskActivityMetrics as ProtoTaskActivityMetrics,
	TaskActivityRuntimeConfig as ProtoTaskActivityRuntimeConfig,
	TaskActivityUpdate as ProtoTaskActivityUpdate,
	TaskActivitySubscriptionRequest,
} from "@shared/proto/dline/task"
import type { TaskActivityRecord, TaskActivityUpdate } from "@shared/task-activity"
import type { Controller } from ".."
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"

function toProtoMetrics(metrics: TaskActivityRecord["metrics"]): ProtoTaskActivityMetrics | undefined {
	return metrics
		? ProtoTaskActivityMetrics.create({
				toolCalls: metrics.toolCalls ?? 0,
				inputTokens: metrics.inputTokens ?? 0,
				outputTokens: metrics.outputTokens ?? 0,
				cacheWriteTokens: metrics.cacheWriteTokens ?? 0,
				cacheReadTokens: metrics.cacheReadTokens ?? 0,
				cacheHitRate: metrics.cacheHitRate ?? 0,
				totalCost: metrics.totalCost ?? 0,
				currency: metrics.currency ?? "",
				contextTokens: metrics.contextTokens ?? 0,
				contextWindow: metrics.contextWindow ?? 0,
				lineCount: metrics.lineCount ?? 0,
			})
		: undefined
}

function toProtoRuntime(runtime: TaskActivityRecord["runtime"]): ProtoTaskActivityRuntimeConfig | undefined {
	return runtime
		? ProtoTaskActivityRuntimeConfig.create({
				profileName: runtime.profileName,
				providerId: runtime.providerId ?? "",
				modelId: runtime.modelId ?? "",
				apiFormat: runtime.apiFormat,
				thinkingEnabled: runtime.thinkingEnabled,
				reasoningEffort: runtime.reasoningEffort,
				thinkingBudgetTokens: runtime.thinkingBudgetTokens,
			})
		: undefined
}

function toProtoActivity(
	activity: TaskActivityRecord,
	cancellable: boolean,
	finishable: boolean,
	retryable: boolean,
): ProtoTaskActivity {
	return ProtoTaskActivity.create({
		activityId: activity.activityId,
		taskId: activity.taskId,
		kind: activity.kind,
		executionMode: activity.executionMode,
		status: activity.status,
		createdAt: activity.createdAt,
		updatedAt: activity.updatedAt,
		finishedAt: activity.finishedAt,
		title: activity.title,
		detail: activity.detail,
		latestEvent: activity.latestEvent,
		timeoutSeconds: activity.timeoutSeconds,
		output: activity.output,
		result: activity.result,
		error: activity.error,
		logPath: activity.logPath,
		parentActivityId: activity.parentActivityId,
		cancellable,
		finishable,
		retryable,
		schemaVersion: activity.schemaVersion,
		currentAttempt: activity.currentAttempt,
		retryUnavailableReason: activity.retryUnavailableReason,
		metrics: toProtoMetrics(activity.metrics),
		runtime: toProtoRuntime(activity.runtime),
		events: activity.events.map((event) =>
			ProtoTaskActivityEvent.create({
				sequence: event.sequence,
				timestamp: event.timestamp,
				kind: event.kind,
				attempt: event.attempt,
				phase: "phase" in event ? event.phase : undefined,
				text: "text" in event ? event.text : undefined,
				toolCallId: "toolCallId" in event ? event.toolCallId : undefined,
				toolName: "toolName" in event ? event.toolName : undefined,
				toolStatus: "toolStatus" in event ? event.toolStatus : undefined,
				summary: "summary" in event ? event.summary : undefined,
				durationMs: "durationMs" in event ? event.durationMs : undefined,
				error: "error" in event ? event.error : undefined,
				status: "status" in event ? event.status : undefined,
				metrics: "metrics" in event ? toProtoMetrics(event.metrics) : undefined,
				retryAttempt: "retryAttempt" in event ? event.retryAttempt : undefined,
				maxRetries: "maxRetries" in event ? event.maxRetries : undefined,
				delayMs: "delayMs" in event ? event.delayMs : undefined,
				cumulativeDelayMs: "cumulativeDelayMs" in event ? event.cumulativeDelayMs : undefined,
			}),
		),
	})
}

function toProtoUpdate(
	update: TaskActivityUpdate,
	capabilities: (activityId: string) => { cancellable: boolean; finishable: boolean; retryable: boolean },
): ProtoTaskActivityUpdate {
	return ProtoTaskActivityUpdate.create({
		sequence: update.sequence,
		snapshot: update.snapshot,
		activities: update.activities.map((activity) => {
			const activityCapabilities = capabilities(activity.activityId)
			return toProtoActivity(
				activity,
				activityCapabilities.cancellable,
				activityCapabilities.finishable,
				activityCapabilities.retryable,
			)
		}),
	})
}

/** Subscribe to the visible task surface's lightweight activity stream. */
export async function subscribeToTaskActivities(
	controller: Controller,
	request: TaskActivitySubscriptionRequest,
	responseStream: StreamingResponseHandler<ProtoTaskActivityUpdate>,
	requestId?: string,
): Promise<void> {
	const activityStore = controller.getCurrentTaskActivityStore(request.taskId)
	if (!activityStore) {
		await responseStream(ProtoTaskActivityUpdate.create({ sequence: 0, snapshot: true, activities: [] }), true)
		return
	}

	const interactive = controller.task?.taskId === request.taskId
	const requestRegistry = getRequestRegistry()
	let completed = false
	const unsubscribe = activityStore.subscribe(
		async (update) => {
			await responseStream(
				toProtoUpdate(update, (activityId) => ({
					cancellable: interactive && activityStore.isCancellable(activityId),
					finishable: interactive && activityStore.isFinishable(activityId),
					retryable: interactive && activityStore.isRetryable(activityId),
				})),
				false,
				update.sequence,
			)
		},
		async () => {
			if (completed) return
			completed = true
			try {
				await responseStream(ProtoTaskActivityUpdate.create({ sequence: 0, snapshot: false, activities: [] }), true)
			} finally {
				if (requestId) requestRegistry.cancelRequest(requestId)
			}
		},
	)
	if (requestId && !completed) {
		requestRegistry.registerRequest(
			requestId,
			unsubscribe,
			{ type: "task_activity_subscription", taskId: request.taskId },
			responseStream,
		)
	}
}
