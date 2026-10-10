import { describe, expect, it } from "vitest"
import type { ApiRateMetricPoint } from "./api-rate-metrics-types"
import {
    aggregateRoundBuckets,
    aggregateRoundUsage,
    calculateDurationRpm,
    calculateRoundCacheHitRate,
    createRoundMetricPoints,
    mergeActiveSecondAndRoundPoints,
} from "./api-request-round-aggregator"
import { API_REQUEST_ROUND_SCHEMA_VERSION, type ApiRequestRoundRecord } from "./api-request-round-types"

function round(overrides: Partial<ApiRequestRoundRecord> = {}): ApiRequestRoundRecord {
    return {
        schemaVersion: API_REQUEST_ROUND_SCHEMA_VERSION,
        taskId: "task-a",
        roundId: "round-a",
        revision: 1,
        logicalRequestId: "request-a",
        apiIndex: 1,
        taskAttempt: 0,
        providerAttempt: 0,
        startedAtMs: 1_000,
        completedAtMs: 3_000,
        providerDurationMs: 2_000,
        status: "completed",
        inputTokens: 1_200,
        outputTokens: 200,
        thoughtsTokens: 50,
        cacheWriteTokens: 100,
        cacheReadTokens: 300,
        cacheUsageReported: true,
        totalCost: 0.1,
        currency: "USD",
        usageQuality: "exact",
        ...overrides,
    }
}

function activePoint(overrides: Partial<ApiRateMetricPoint> = {}): ApiRateMetricPoint {
    return {
        bucketStartMs: 0,
        bucketEndMs: 60_000,
        activeSeconds: 2,
        requestCount: 1,
        tokenCount: 500,
        requestsPerMinute: 30,
        tokensPerMinute: 15_000,
        tokenQuality: "exact",
        ...overrides,
    }
}

describe("API request round aggregation", () => {
    it("calculates duration RPM from Provider durations and includes every terminal status", () => {
        const rounds = [
            round({ roundId: "completed", providerDurationMs: 2_000, status: "completed" }),
            round({ roundId: "failed", providerDurationMs: 4_000, status: "failed" }),
            round({ roundId: "cancelled", providerDurationMs: 3_000, status: "cancelled" }),
            round({ roundId: "aborted", providerDurationMs: 3_000, status: "aborted" }),
        ]

        expect(calculateDurationRpm(rounds)).toEqual({ roundCount: 4, durationMs: 12_000, requestsPerMinute: 20 })
    })

    it("uses token-weighted cache hit aggregation instead of averaging percentages", () => {
        const aggregate = aggregateRoundUsage([
            round(),
            round({
                roundId: "round-b",
                logicalRequestId: "request-b",
                completedAtMs: 5_000,
                providerDurationMs: 4_000,
                status: "failed",
                inputTokens: 400,
                outputTokens: 0,
                thoughtsTokens: 0,
                cacheWriteTokens: 0,
                cacheReadTokens: 0,
                totalCost: 0,
            }),
        ])

        expect(aggregate.cacheHitRate).toBe(0.15)
        expect(aggregate.cacheUsageAvailable).toBe(true)
        expect(aggregate.requestsPerMinute).toBe(20)
        expect(aggregate.providerDurationMs).toBe(6_000)
        expect(aggregate.providerRoundCount).toBe(2)
        expect(aggregate.completedRoundCount).toBe(1)
        expect(aggregate.failedRoundCount).toBe(1)
    })

    it("distinguishes explicit zero cache hit from unavailable cache usage", () => {
        const zero = round({ inputTokens: 100, cacheWriteTokens: 0, cacheReadTokens: 0 })
        const unavailable = round({ cacheUsageReported: false })

        expect(calculateRoundCacheHitRate(zero)).toBe(0)
        expect(calculateRoundCacheHitRate(unavailable)).toBeUndefined()
        expect(aggregateRoundUsage([zero]).cacheHitRate).toBe(0)
        expect(aggregateRoundUsage([unavailable]).cacheHitRate).toBeUndefined()
    })

    it("keeps only the latest 60 rounds in chronological order", () => {
        const rounds = Array.from({ length: 65 }, (_, index) =>
            round({
                roundId: `round-${index}`,
                logicalRequestId: `request-${index}`,
                completedAtMs: index * 1_000,
            }),
        )

        const points = createRoundMetricPoints(rounds, 60)

        expect(points).toHaveLength(60)
        expect(points[0]?.roundId).toBe("round-5")
        expect(points.at(-1)?.roundId).toBe("round-64")
    })

    it("merges duration RPM and round usage into active-second buckets without changing TPM", () => {
        const roundBuckets = aggregateRoundBuckets(
            [
                round({ completedAtMs: 10_000, providerDurationMs: 2_000 }),
                round({
                    roundId: "round-b",
                    logicalRequestId: "request-b",
                    completedAtMs: 20_000,
                    providerDurationMs: 4_000,
                    inputTokens: 400,
                    outputTokens: 0,
                    thoughtsTokens: 0,
                    cacheWriteTokens: 0,
                    cacheReadTokens: 0,
                }),
            ],
            "minute",
            0,
            60_000,
        )
        const merged = mergeActiveSecondAndRoundPoints([activePoint()], roundBuckets)

        expect(merged).toHaveLength(1)
        expect(merged[0]).toMatchObject({
            tokenCount: 500,
            tokensPerMinute: 15_000,
            requestsPerMinute: 20,
            rpmBasis: "provider_duration",
            providerRoundCount: 2,
            cacheHitRate: 0.15,
        })

        const legacyOnly = mergeActiveSecondAndRoundPoints([activePoint()], [])
        expect(legacyOnly[0]).toMatchObject({ requestsPerMinute: 30, rpmBasis: "legacy_active_seconds" })
    })
})
