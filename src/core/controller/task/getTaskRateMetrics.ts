import type { ApiRateTokenQuality } from "@core/task/performance/api-rate-metrics-types"
import type { ApiRequestRoundStatus } from "@core/task/performance/api-request-round-types"
import type {
	TaskRateMetricsResolution as DomainResolution,
	TaskRateRpmBasis as DomainRpmBasis,
	TaskRateUsageQuality as DomainUsageQuality,
} from "@core/task/performance/task-rate-metrics-types"
import {
	type GetTaskRateMetricsRequest,
	GetTaskRateMetricsResponse,
	TaskRateMetricsResolution,
	TaskRateRoundStatus,
	TaskRateRpmBasis,
	TaskRateTokenQuality,
	TaskRateUsageQuality,
} from "@shared/proto/dline/task"
import { Logger } from "@shared/services/Logger"
import type { Controller } from ".."

/** Return task-local API rate history on demand without projecting it into ExtensionState. */
export async function getTaskRateMetrics(
	controller: Controller,
	request: GetTaskRateMetricsRequest,
): Promise<GetTaskRateMetricsResponse> {
	const startedAt = performance.now()
	const task = controller.task
	if (!task || task.taskId !== request.taskId || !request.taskInstanceId || task.taskInstanceId !== request.taskInstanceId) {
		throw new Error("Task rate metrics query requires the matching opened Task instance")
	}
	if (!Number.isFinite(request.startMs) || !Number.isFinite(request.endMs) || request.endMs <= request.startMs) {
		throw new Error("Task rate metrics query requires a valid time range")
	}

	const result = await task.queryTaskRateMetrics({
		resolution: toDomainResolution(request.resolution),
		startMs: request.startMs,
		endMs: request.endMs,
		...(request.maxPoints > 0 && { maxPoints: request.maxPoints }),
	})

	if (controller.task !== task) {
		throw new Error("Task rate metrics query no longer belongs to the opened Task instance")
	}
	const response = GetTaskRateMetricsResponse.create({
		taskId: task.taskId,
		taskInstanceId: task.taskInstanceId,
		points: result.points.map((point) => ({
			bucketStartMs: point.bucketStartMs,
			bucketEndMs: point.bucketEndMs,
			...(point.activeSeconds === undefined ? {} : { activeSeconds: point.activeSeconds }),
			...(point.requestCount === undefined ? {} : { requestCount: point.requestCount }),
			...(point.tokenCount === undefined ? {} : { tokenCount: point.tokenCount }),
			...(point.requestsPerMinute === undefined ? {} : { requestsPerMinute: point.requestsPerMinute }),
			...(point.tokensPerMinute === undefined ? {} : { tokensPerMinute: point.tokensPerMinute }),
			...(point.tokenQuality === undefined ? {} : { tokenQuality: toProtoTokenQuality(point.tokenQuality) }),
			provisional: point.provisional ?? false,
			...(point.inputTokens === undefined ? {} : { inputTokens: point.inputTokens }),
			...(point.outputTokens === undefined ? {} : { outputTokens: point.outputTokens }),
			...(point.thoughtsTokens === undefined ? {} : { thoughtsTokens: point.thoughtsTokens }),
			...(point.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: point.cacheWriteTokens }),
			...(point.cacheReadTokens === undefined ? {} : { cacheReadTokens: point.cacheReadTokens }),
			...(point.cacheHitRate === undefined ? {} : { cacheHitRate: point.cacheHitRate }),
			cacheUsageAvailable: point.cacheUsageAvailable,
			usageAvailable: point.usageAvailable,
			...(point.providerDurationMs === undefined ? {} : { providerDurationMs: point.providerDurationMs }),
			...(point.executionDurationMs === undefined ? {} : { executionDurationMs: point.executionDurationMs }),
			executionCount: point.executionCount ?? 0,
			completedExecutionCount: point.completedExecutionCount ?? 0,
			failedExecutionCount: point.failedExecutionCount ?? 0,
			cancelledExecutionCount: point.cancelledExecutionCount ?? 0,
			abortedExecutionCount: point.abortedExecutionCount ?? 0,
			providerRoundCount: point.providerRoundCount,
			completedRoundCount: point.completedRoundCount,
			failedRoundCount: point.failedRoundCount,
			cancelledRoundCount: point.cancelledRoundCount,
			abortedRoundCount: point.abortedRoundCount,
			rpmBasis: toProtoRpmBasis(point.rpmBasis),
			usageQuality: toProtoUsageQuality(point.usageQuality),
			...(point.status === undefined ? {} : { status: toProtoRoundStatus(point.status) }),
			...(point.roundId === undefined ? {} : { roundId: point.roundId }),
			...(point.logicalRequestId === undefined ? {} : { logicalRequestId: point.logicalRequestId }),
			...(point.apiIndex === undefined ? {} : { apiIndex: point.apiIndex }),
			...(point.taskAttempt === undefined ? {} : { taskAttempt: point.taskAttempt }),
			...(point.providerAttempt === undefined ? {} : { providerAttempt: point.providerAttempt }),
			...(point.startedAtMs === undefined ? {} : { startedAtMs: point.startedAtMs }),
			...(point.completedAtMs === undefined ? {} : { completedAtMs: point.completedAtMs }),
			...(point.totalCost === undefined ? {} : { totalCost: point.totalCost }),
			...(point.currency === undefined ? {} : { currency: point.currency }),
		})),
		degraded: result.degraded,
		truncated: result.truncated,
		...(result.retentionStartMs !== undefined && { retentionStartMs: result.retentionStartMs }),
	})
	Logger.debug(
		`[Task ${request.taskId}] API rate metrics RPC: durationMs=${Math.round(performance.now() - startedAt)}, resolution=${toDomainResolution(request.resolution)}, points=${response.points.length}, degraded=${response.degraded}, truncated=${response.truncated}`,
	)
	return response
}

function toDomainResolution(resolution: TaskRateMetricsResolution): DomainResolution {
	switch (resolution) {
		case TaskRateMetricsResolution.TASK_RATE_METRICS_RESOLUTION_ROUND:
			return "round"
		case TaskRateMetricsResolution.TASK_RATE_METRICS_RESOLUTION_MINUTE:
			return "minute"
		case TaskRateMetricsResolution.TASK_RATE_METRICS_RESOLUTION_HOUR:
			return "hour"
		case TaskRateMetricsResolution.TASK_RATE_METRICS_RESOLUTION_DAY:
			return "day"
		default:
			throw new Error("Task rate metrics query requires a supported resolution")
	}
}

function toProtoTokenQuality(quality: ApiRateTokenQuality): TaskRateTokenQuality {
	switch (quality) {
		case "mixed":
			return TaskRateTokenQuality.TASK_RATE_TOKEN_QUALITY_MIXED
		case "exact":
			return TaskRateTokenQuality.TASK_RATE_TOKEN_QUALITY_EXACT
		default:
			return TaskRateTokenQuality.TASK_RATE_TOKEN_QUALITY_ESTIMATED
	}
}

function toProtoRpmBasis(basis: DomainRpmBasis): TaskRateRpmBasis {
	switch (basis) {
		case "execution_duration":
			return TaskRateRpmBasis.TASK_RATE_RPM_BASIS_EXECUTION_DURATION
		case "provider_duration":
			return TaskRateRpmBasis.TASK_RATE_RPM_BASIS_PROVIDER_DURATION
		case "legacy_active_seconds":
			return TaskRateRpmBasis.TASK_RATE_RPM_BASIS_LEGACY_ACTIVE_SECONDS
		default:
			return TaskRateRpmBasis.TASK_RATE_RPM_BASIS_UNAVAILABLE
	}
}

function toProtoUsageQuality(quality: DomainUsageQuality): TaskRateUsageQuality {
	switch (quality) {
		case "estimated":
			return TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_ESTIMATED
		case "exact":
			return TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_EXACT
		case "legacy":
			return TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_LEGACY
		case "mixed":
			return TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_MIXED
		default:
			return TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_NONE
	}
}

function toProtoRoundStatus(status: ApiRequestRoundStatus): TaskRateRoundStatus {
	switch (status) {
		case "completed":
			return TaskRateRoundStatus.TASK_RATE_ROUND_STATUS_COMPLETED
		case "failed":
			return TaskRateRoundStatus.TASK_RATE_ROUND_STATUS_FAILED
		case "cancelled":
			return TaskRateRoundStatus.TASK_RATE_ROUND_STATUS_CANCELLED
		case "aborted":
			return TaskRateRoundStatus.TASK_RATE_ROUND_STATUS_ABORTED
	}
}
