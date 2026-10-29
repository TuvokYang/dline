import type { ApiRateMetricPoint, ApiRateMetricsResolution } from "./api-rate-metrics-types"
import type { ApiResponseExecutionRecord, ApiResponseExecutionStatus } from "./api-response-execution-types"
import type { TaskRateMetricPoint } from "./task-rate-metrics-types"

const MILLISECONDS_PER_MINUTE = 60_000
const RESOLUTION_MILLISECONDS: Record<ApiRateMetricsResolution, number> = {
    minute: MILLISECONDS_PER_MINUTE,
    hour: 60 * MILLISECONDS_PER_MINUTE,
    day: 24 * 60 * MILLISECONDS_PER_MINUTE,
}

export interface ExecutionDurationRpmAggregate {
    executionCount: number
    executionDurationMs: number
    requestsPerMinute?: number
    completedExecutionCount: number
    failedExecutionCount: number
    cancelledExecutionCount: number
    abortedExecutionCount: number
}

export function calculateExecutionDurationRpm(executions: readonly ApiResponseExecutionRecord[]): ExecutionDurationRpmAggregate {
    const statusCounts: Record<ApiResponseExecutionStatus, number> = {
        completed: 0,
        failed: 0,
        cancelled: 0,
        aborted: 0,
    }
    let executionCount = 0
    let executionDurationMs = 0
    for (const execution of executions) {
        const duration = execution.executionDurationMs
        if (!Number.isFinite(duration) || duration <= 0) continue
        executionCount += 1
        executionDurationMs += duration
        statusCounts[execution.status] += 1
    }
    return {
        executionCount,
        executionDurationMs,
        ...(executionCount > 0 && executionDurationMs > 0
            ? { requestsPerMinute: Math.round((executionCount * MILLISECONDS_PER_MINUTE) / executionDurationMs) }
            : {}),
        completedExecutionCount: statusCounts.completed,
        failedExecutionCount: statusCounts.failed,
        cancelledExecutionCount: statusCounts.cancelled,
        abortedExecutionCount: statusCounts.aborted,
    }
}

export function createExecutionMetricPoints(
    executions: readonly ApiResponseExecutionRecord[],
    limit = 60,
): TaskRateMetricPoint[] {
    return [...executions]
        .sort(
            (left, right) =>
                left.completedAtMs - right.completedAtMs ||
                left.providerAttempt - right.providerAttempt ||
                left.executionId.localeCompare(right.executionId),
        )
        .slice(-Math.max(1, Math.trunc(limit)))
        .map((execution) => {
            const aggregate = calculateExecutionDurationRpm([execution])
            return {
                ...emptyPoint(execution.completedAtMs, execution.completedAtMs + 1),
                ...(aggregate.requestsPerMinute === undefined ? {} : { requestsPerMinute: aggregate.requestsPerMinute }),
                executionDurationMs: aggregate.executionDurationMs,
                executionCount: aggregate.executionCount,
                completedExecutionCount: aggregate.completedExecutionCount,
                failedExecutionCount: aggregate.failedExecutionCount,
                cancelledExecutionCount: aggregate.cancelledExecutionCount,
                abortedExecutionCount: aggregate.abortedExecutionCount,
                rpmBasis: "execution_duration",
                providerDurationMs: execution.providerDurationMs,
                status: execution.status,
                roundId: execution.roundId,
                logicalRequestId: execution.logicalRequestId,
                apiIndex: execution.apiIndex,
                taskAttempt: execution.taskAttempt,
                providerAttempt: execution.providerAttempt,
                startedAtMs: execution.startedAtMs,
                completedAtMs: execution.completedAtMs,
            }
        })
}

export function aggregateExecutionBuckets(
    executions: readonly ApiResponseExecutionRecord[],
    resolution: ApiRateMetricsResolution,
    startMs: number,
    endMs: number,
): TaskRateMetricPoint[] {
    const bucketMs = RESOLUTION_MILLISECONDS[resolution]
    const buckets = new Map<number, ApiResponseExecutionRecord[]>()
    for (const execution of executions) {
        if (execution.completedAtMs < startMs || execution.completedAtMs >= endMs) continue
        const bucketStartMs = Math.floor(execution.completedAtMs / bucketMs) * bucketMs
        const bucket = buckets.get(bucketStartMs) ?? []
        bucket.push(execution)
        buckets.set(bucketStartMs, bucket)
    }
    return [...buckets.entries()]
        .sort(([left], [right]) => left - right)
        .map(([bucketStartMs, bucketExecutions]) => {
            const aggregate = calculateExecutionDurationRpm(bucketExecutions)
            return {
                ...emptyPoint(bucketStartMs, bucketStartMs + bucketMs),
                ...(aggregate.requestsPerMinute === undefined ? {} : { requestsPerMinute: aggregate.requestsPerMinute }),
                executionDurationMs: aggregate.executionDurationMs,
                executionCount: aggregate.executionCount,
                completedExecutionCount: aggregate.completedExecutionCount,
                failedExecutionCount: aggregate.failedExecutionCount,
                cancelledExecutionCount: aggregate.cancelledExecutionCount,
                abortedExecutionCount: aggregate.abortedExecutionCount,
                rpmBasis: aggregate.executionCount > 0 ? "execution_duration" : "unavailable",
            }
        })
}

export function mergeExecutionAndTaskRatePoints(
    roundPoints: readonly TaskRateMetricPoint[],
    executionPoints: readonly TaskRateMetricPoint[],
    activePoints: readonly ApiRateMetricPoint[],
): TaskRateMetricPoint[] {
    const points = new Map<number, TaskRateMetricPoint>()
    for (const round of roundPoints) points.set(round.bucketStartMs, withoutLegacyRpm(round))
    for (const active of activePoints) {
        const existing = points.get(active.bucketStartMs) ?? emptyPoint(active.bucketStartMs, active.bucketEndMs)
        points.set(active.bucketStartMs, {
            ...existing,
            activeSeconds: active.activeSeconds,
            requestCount: active.requestCount,
            tokenCount: active.tokenCount,
            tokensPerMinute: active.tokensPerMinute,
            tokenQuality: active.tokenQuality,
            provisional: active.provisional,
        })
    }
    for (const execution of executionPoints) {
        const existing = points.get(execution.bucketStartMs) ?? emptyPoint(execution.bucketStartMs, execution.bucketEndMs)
        points.set(execution.bucketStartMs, mergeExecutionFields(existing, execution))
    }
    return [...points.values()]
        .map((point) => (point.rpmBasis === "execution_duration" ? point : withoutLegacyRpm(point)))
        .sort((left, right) => left.bucketStartMs - right.bucketStartMs)
}

export function mergeExecutionAndRoundPoints(
    roundPoints: readonly TaskRateMetricPoint[],
    executionPoints: readonly TaskRateMetricPoint[],
): TaskRateMetricPoint[] {
    const points = new Map<string, TaskRateMetricPoint>()
    for (const round of roundPoints) {
        if (round.roundId) points.set(round.roundId, withoutLegacyRpm(round))
    }
    for (const execution of executionPoints) {
        const key = execution.roundId ?? `execution:${execution.bucketStartMs}:${points.size}`
        const round = points.get(key)
        points.set(key, round ? mergeExecutionFields(round, execution, true) : execution)
    }
    return [...points.values()]
        .map((point) => (point.rpmBasis === "execution_duration" ? point : withoutLegacyRpm(point)))
        .sort((left, right) => left.bucketStartMs - right.bucketStartMs)
}

function mergeExecutionFields(
    base: TaskRateMetricPoint,
    execution: TaskRateMetricPoint,
    includeIdentity = false,
): TaskRateMetricPoint {
    return {
        ...base,
        ...(execution.requestsPerMinute === undefined ? {} : { requestsPerMinute: execution.requestsPerMinute }),
        ...(execution.executionDurationMs === undefined ? {} : { executionDurationMs: execution.executionDurationMs }),
        executionCount: execution.executionCount ?? 0,
        completedExecutionCount: execution.completedExecutionCount ?? 0,
        failedExecutionCount: execution.failedExecutionCount ?? 0,
        cancelledExecutionCount: execution.cancelledExecutionCount ?? 0,
        abortedExecutionCount: execution.abortedExecutionCount ?? 0,
        rpmBasis: execution.rpmBasis,
        ...(includeIdentity
            ? {
                  status: execution.status,
                  roundId: execution.roundId,
                  logicalRequestId: execution.logicalRequestId,
                  apiIndex: execution.apiIndex,
                  taskAttempt: execution.taskAttempt,
                  providerAttempt: execution.providerAttempt,
                  startedAtMs: execution.startedAtMs,
                  completedAtMs: execution.completedAtMs,
              }
            : {}),
    }
}

function withoutLegacyRpm(point: TaskRateMetricPoint): TaskRateMetricPoint {
    const { requestsPerMinute: _requestsPerMinute, ...rest } = point
    return {
        ...rest,
        executionCount: point.executionCount ?? 0,
        completedExecutionCount: point.completedExecutionCount ?? 0,
        failedExecutionCount: point.failedExecutionCount ?? 0,
        cancelledExecutionCount: point.cancelledExecutionCount ?? 0,
        abortedExecutionCount: point.abortedExecutionCount ?? 0,
        rpmBasis: "unavailable",
    }
}

function emptyPoint(bucketStartMs: number, bucketEndMs: number): TaskRateMetricPoint {
    return {
        bucketStartMs,
        bucketEndMs,
        cacheUsageAvailable: false,
        usageAvailable: false,
        providerRoundCount: 0,
        completedRoundCount: 0,
        failedRoundCount: 0,
        cancelledRoundCount: 0,
        abortedRoundCount: 0,
        executionCount: 0,
        completedExecutionCount: 0,
        failedExecutionCount: 0,
        cancelledExecutionCount: 0,
        abortedExecutionCount: 0,
        rpmBasis: "unavailable",
        usageQuality: "none",
    }
}
