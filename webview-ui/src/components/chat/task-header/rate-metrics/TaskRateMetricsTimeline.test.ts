import { type TaskRateMetricPoint, TaskRateRpmBasis, TaskRateUsageQuality } from "@shared/proto/dline/task"
import { describe, expect, it } from "vitest"
import {
    createTaskRateMetricsQueryWindow,
    fillTaskRateMetricsTimeline,
    type TaskRateMetricsResolution,
} from "./TaskRateMetricsTimeline"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const NOW_MS = Date.parse("2026-08-10T12:34:45.000Z")

function point(bucketStartMs: number, bucketMs: number, overrides: Partial<TaskRateMetricPoint> = {}): TaskRateMetricPoint {
    return {
        bucketStartMs,
        bucketEndMs: bucketStartMs + bucketMs,
        provisional: false,
        cacheUsageAvailable: true,
        usageAvailable: true,
        providerRoundCount: 1,
        completedRoundCount: 1,
        failedRoundCount: 0,
        cancelledRoundCount: 0,
        abortedRoundCount: 0,
        rpmBasis: TaskRateRpmBasis.TASK_RATE_RPM_BASIS_EXECUTION_DURATION,
        usageQuality: TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_EXACT,
        executionCount: 1,
        completedExecutionCount: 1,
        failedExecutionCount: 0,
        cancelledExecutionCount: 0,
        abortedExecutionCount: 0,
        inputTokens: 100,
        ...overrides,
    }
}

function expectedEndMs(bucketMs: number): number {
    return Math.floor(NOW_MS / bucketMs) * bucketMs + bucketMs
}

describe("TaskRateMetricsTimeline", () => {
    it.each([
        ["minute", MINUTE_MS, 60],
        ["hour", HOUR_MS, 24],
        ["day", DAY_MS, 30],
    ] as const)("creates a bounded %s query window", (resolution, bucketMs, maxPoints) => {
        const window = createTaskRateMetricsQueryWindow(resolution satisfies TaskRateMetricsResolution, NOW_MS)
        const endMs = expectedEndMs(bucketMs)

        expect(window).toEqual({
            bucketMs,
            startMs: endMs - maxPoints * bucketMs,
            endMs,
            maxPoints,
        })
    })

    it("fills the complete query window without changing source facts", () => {
        const first = point(HOUR_MS, HOUR_MS, { inputTokens: 100 })
        const last = point(2 * HOUR_MS, HOUR_MS, { inputTokens: 400 })
        const window = { bucketMs: HOUR_MS, startMs: 0, endMs: 4 * HOUR_MS, maxPoints: 4 }

        const timeline = fillTaskRateMetricsTimeline([last, first], window)

        expect(timeline).toHaveLength(4)
        expect(timeline.map(({ bucketStartMs }) => bucketStartMs)).toEqual([0, HOUR_MS, 2 * HOUR_MS, 3 * HOUR_MS])
        expect(timeline[1]).toBe(first)
        expect(timeline[2]).toBe(last)
        expect(timeline[0]).toMatchObject({
            bucketStartMs: 0,
            bucketEndMs: HOUR_MS,
            cacheUsageAvailable: false,
            usageAvailable: false,
            providerRoundCount: 0,
            executionCount: 0,
        })
        expect(timeline[0]?.inputTokens).toBeUndefined()
        expect(timeline[3]?.inputTokens).toBeUndefined()
    })

    it("keeps an empty history empty and caps a sparse timeline to the configured window", () => {
        const window = {
            bucketMs: MINUTE_MS,
            startMs: 31 * MINUTE_MS,
            endMs: 91 * MINUTE_MS,
            maxPoints: 60,
        }
        expect(fillTaskRateMetricsTimeline([], window)).toEqual([])

        const timeline = fillTaskRateMetricsTimeline([point(0, MINUTE_MS), point(90 * MINUTE_MS, MINUTE_MS)], window)
        expect(timeline).toHaveLength(60)
        expect(timeline[0]?.bucketStartMs).toBe(31 * MINUTE_MS)
        expect(timeline[0]?.inputTokens).toBeUndefined()
        expect(timeline.at(-1)?.bucketStartMs).toBe(90 * MINUTE_MS)
        expect(timeline.at(-1)?.inputTokens).toBe(100)
    })
})
