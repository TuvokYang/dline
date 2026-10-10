import { type TaskRateMetricPoint, TaskRateRpmBasis, TaskRateUsageQuality } from "@shared/proto/dline/task"

export type TaskRateMetricsResolution = "minute" | "hour" | "day"

interface TaskRateMetricsResolutionConfig {
    readonly bucketMs: number
    readonly maxPoints: number
}

export interface TaskRateMetricsQueryWindow extends TaskRateMetricsResolutionConfig {
    readonly startMs: number
    readonly endMs: number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const RESOLUTION_CONFIG: Record<TaskRateMetricsResolution, TaskRateMetricsResolutionConfig> = {
    minute: { bucketMs: MINUTE_MS, maxPoints: 60 },
    hour: { bucketMs: HOUR_MS, maxPoints: 24 },
    day: { bucketMs: DAY_MS, maxPoints: 30 },
}

/** Create an aligned query window that includes the currently active time bucket. */
export function createTaskRateMetricsQueryWindow(
    resolution: TaskRateMetricsResolution,
    nowMs: number,
): TaskRateMetricsQueryWindow {
    const config = RESOLUTION_CONFIG[resolution]
    const endMs = Math.floor(nowMs / config.bucketMs) * config.bucketMs + config.bucketMs
    return {
        ...config,
        startMs: endMs - config.maxPoints * config.bucketMs,
        endMs,
    }
}

/** Fill every bucket in a bounded query window once at least one metric fact exists. */
export function fillTaskRateMetricsTimeline(
    points: readonly TaskRateMetricPoint[],
    window: TaskRateMetricsQueryWindow,
): TaskRateMetricPoint[] {
    if (points.length === 0) return []

    const pointsByBucket = new Map<number, TaskRateMetricPoint>()
    for (const point of points) {
        if (point.bucketStartMs >= window.startMs && point.bucketStartMs < window.endMs) {
            pointsByBucket.set(point.bucketStartMs, point)
        }
    }
    if (pointsByBucket.size === 0) return []

    const timeline: TaskRateMetricPoint[] = []
    for (
        let bucketStartMs = window.startMs;
        bucketStartMs < window.endMs && timeline.length < window.maxPoints;
        bucketStartMs += window.bucketMs
    ) {
        timeline.push(pointsByBucket.get(bucketStartMs) ?? createEmptyMetricPoint(bucketStartMs, window.bucketMs))
    }
    return timeline
}

function createEmptyMetricPoint(bucketStartMs: number, bucketMs: number): TaskRateMetricPoint {
    return {
        bucketStartMs,
        bucketEndMs: bucketStartMs + bucketMs,
        provisional: false,
        cacheUsageAvailable: false,
        usageAvailable: false,
        providerRoundCount: 0,
        completedRoundCount: 0,
        failedRoundCount: 0,
        cancelledRoundCount: 0,
        abortedRoundCount: 0,
        rpmBasis: TaskRateRpmBasis.TASK_RATE_RPM_BASIS_UNAVAILABLE,
        usageQuality: TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_NONE,
        executionCount: 0,
        completedExecutionCount: 0,
        failedExecutionCount: 0,
        cancelledExecutionCount: 0,
        abortedExecutionCount: 0,
    }
}
