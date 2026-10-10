import { describe, expect, it } from "vitest"
import type { ApiRateMetricPoint } from "./api-rate-metrics-types"
import {
    aggregateExecutionBuckets,
    calculateExecutionDurationRpm,
    createExecutionMetricPoints,
    mergeExecutionAndTaskRatePoints,
} from "./api-response-execution-aggregator"
import type { ApiResponseExecutionRecord } from "./api-response-execution-types"
import type { TaskRateMetricPoint } from "./task-rate-metrics-types"

function execution(overrides: Partial<ApiResponseExecutionRecord> = {}): ApiResponseExecutionRecord {
    return {
        schemaVersion: 1,
        taskId: "task-a",
        executionId: "execution-a",
        revision: 0,
        roundId: "execution-a",
        logicalRequestId: "request-a",
        apiIndex: 1,
        taskAttempt: 0,
        providerAttempt: 0,
        startedAtMs: 1_000,
        providerCompletedAtMs: 3_000,
        completedAtMs: 11_000,
        providerDurationMs: 2_000,
        executionDurationMs: 10_000,
        status: "completed",
        terminalKind: "tools_settled",
        toolCount: 1,
        completedToolCount: 1,
        failedToolCount: 0,
        cancelledToolCount: 0,
        ...overrides,
    }
}

function activePoint(): ApiRateMetricPoint {
    return {
        bucketStartMs: 0,
        bucketEndMs: 60_000,
        activeSeconds: 2,
        requestCount: 2,
        tokenCount: 500,
        requestsPerMinute: 60,
        tokensPerMinute: 15_000,
        tokenQuality: "exact",
    }
}

function roundPoint(): TaskRateMetricPoint {
    return {
        bucketStartMs: 0,
        bucketEndMs: 60_000,
        requestCount: 2,
        inputTokens: 400,
        outputTokens: 100,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        cacheHitRate: 0,
        cacheUsageAvailable: true,
        usageAvailable: true,
        providerDurationMs: 4_000,
        providerRoundCount: 2,
        completedRoundCount: 2,
        failedRoundCount: 0,
        cancelledRoundCount: 0,
        abortedRoundCount: 0,
        rpmBasis: "unavailable",
        usageQuality: "exact",
    }
}

describe("API response execution aggregation", () => {
    it("calculates RPM from complete execution duration for every terminal status", () => {
        const executions = [
            execution({ executionId: "completed", status: "completed", executionDurationMs: 10_000 }),
            execution({ executionId: "failed", status: "failed", executionDurationMs: 5_000 }),
            execution({ executionId: "cancelled", status: "cancelled", executionDurationMs: 3_000 }),
            execution({ executionId: "aborted", status: "aborted", executionDurationMs: 2_000 }),
        ]

        expect(calculateExecutionDurationRpm(executions)).toEqual({
            executionCount: 4,
            executionDurationMs: 20_000,
            requestsPerMinute: 12,
            completedExecutionCount: 1,
            failedExecutionCount: 1,
            cancelledExecutionCount: 1,
            abortedExecutionCount: 1,
        })
    })

    it("uses completion time buckets and preserves active-second TPM while replacing legacy RPM", () => {
        const executionPoints = aggregateExecutionBuckets(
            [
                execution({ executionId: "execution-a", completedAtMs: 10_000, executionDurationMs: 10_000 }),
                execution({
                    executionId: "execution-b",
                    roundId: "execution-b",
                    logicalRequestId: "request-b",
                    completedAtMs: 20_000,
                    executionDurationMs: 5_000,
                }),
            ],
            "minute",
            0,
            60_000,
        )
        const merged = mergeExecutionAndTaskRatePoints([roundPoint()], executionPoints, [activePoint()])

        expect(merged).toHaveLength(1)
        expect(merged[0]).toMatchObject({
            tokenCount: 500,
            tokensPerMinute: 15_000,
            requestsPerMinute: 8,
            executionDurationMs: 15_000,
            executionCount: 2,
            rpmBasis: "execution_duration",
            providerDurationMs: 4_000,
        })
    })

    it("keeps RPM unavailable when no execution fact exists", () => {
        const merged = mergeExecutionAndTaskRatePoints([roundPoint()], [], [activePoint()])

        expect(merged[0]).toMatchObject({ tokensPerMinute: 15_000, rpmBasis: "unavailable" })
        expect(merged[0]?.requestsPerMinute).toBeUndefined()
        expect(merged[0]?.executionDurationMs).toBeUndefined()
        expect(merged[0]?.executionCount).toBe(0)
    })

    it("creates bounded per-execution compatibility points without Provider-duration fallback", () => {
        const points = createExecutionMetricPoints(
            Array.from({ length: 65 }, (_, index) =>
                execution({
                    executionId: `execution-${index}`,
                    roundId: `round-${index}`,
                    logicalRequestId: `request-${index}`,
                    completedAtMs: index * 1_000,
                }),
            ),
            60,
        )

        expect(points).toHaveLength(60)
        expect(points[0]).toMatchObject({ roundId: "round-5", requestsPerMinute: 6, rpmBasis: "execution_duration" })
        expect(points.at(-1)?.roundId).toBe("round-64")
    })
})
