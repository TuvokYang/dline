import { describe, expect, it } from "vitest"
import { aggregateApiRateMetrics, compactApiRateMetrics, foldApiRateSecondRevisions } from "./api-rate-metrics-aggregator"
import { API_RATE_METRICS_SCHEMA_VERSION, type ApiRateSecondRecord } from "./api-rate-metrics-types"

function secondRecord(overrides: Partial<ApiRateSecondRecord> = {}): ApiRateSecondRecord {
    return {
        schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
        kind: "second",
        second: 0,
        revision: 0,
        signals: ["stream_tokens"],
        requestCount: 0,
        estimatedTokens: 100,
        effectiveTokens: 100,
        tokenQuality: "estimated",
        runningActiveSeconds: 1,
        runningRequestCount: 0,
        runningTokenCount: 100,
        requestsPerMinute: 0,
        tokensPerMinute: 6_000,
        ...overrides,
    }
}

describe("api rate metrics aggregation", () => {
    it("uses the highest revision as the canonical value for each active second", () => {
        const canonical = foldApiRateSecondRevisions([
            secondRecord({ second: 60, revision: 0, effectiveTokens: 100 }),
            secondRecord({ second: 60, revision: 2, effectiveTokens: 180, tokenQuality: "exact" }),
            secondRecord({ second: 60, revision: 1, effectiveTokens: 140, tokenQuality: "mixed" }),
        ])

        expect(canonical).toEqual([
            expect.objectContaining({ second: 60, revision: 2, effectiveTokens: 180, tokenQuality: "exact" }),
        ])
    })

    it("compacts active-second history into age-appropriate rollups without losing counts", () => {
        const nowSecond = 500 * 24 * 60 * 60
        const records = compactApiRateMetrics(
            [
                secondRecord({ second: nowSecond - 60 * 60, requestCount: 1, effectiveTokens: 10 }),
                secondRecord({ second: nowSecond - 3 * 24 * 60 * 60, requestCount: 1, effectiveTokens: 20 }),
                secondRecord({ second: nowSecond - 3 * 24 * 60 * 60 + 1, requestCount: 0, effectiveTokens: 30 }),
                secondRecord({ second: nowSecond - 40 * 24 * 60 * 60, requestCount: 2, effectiveTokens: 40 }),
                secondRecord({ second: nowSecond - 400 * 24 * 60 * 60, requestCount: 3, effectiveTokens: 50 }),
            ],
            nowSecond,
        )

        expect(records).toEqual([
            expect.objectContaining({ kind: "rollup", resolution: "day", activeSeconds: 1, requestCount: 3, tokenCount: 50 }),
            expect.objectContaining({ kind: "rollup", resolution: "hour", activeSeconds: 1, requestCount: 2, tokenCount: 40 }),
            expect.objectContaining({ kind: "rollup", resolution: "minute", activeSeconds: 2, requestCount: 1, tokenCount: 50 }),
            expect.objectContaining({ kind: "second", requestCount: 1, effectiveTokens: 10 }),
        ])
    })

    it("uses API-active seconds for both RPM and TPM", () => {
        const records = Array.from({ length: 10 }, (_, second) =>
            secondRecord({
                second,
                signals: second === 0 ? ["task_active", "provider_active", "request_start", "stream_tokens"] : ["task_active"],
                requestCount: second === 0 ? 1 : 0,
                estimatedTokens: second === 0 ? 120 : 0,
                effectiveTokens: second === 0 ? 120 : 0,
                tokenQuality: "exact",
            }),
        )

        expect(aggregateApiRateMetrics(records, { resolution: "minute", startSecond: 0, endSecond: 60 })).toEqual([
            {
                bucketStartMs: 0,
                bucketEndMs: 60_000,
                activeSeconds: 1,
                requestCount: 1,
                tokenCount: 120,
                requestsPerMinute: 60,
                tokensPerMinute: 7_200,
                tokenQuality: "exact",
            },
        ])
    })

    it("recalculates legacy active-only minute rates and omits idle buckets", () => {
        const points = aggregateApiRateMetrics(
            [
                secondRecord({ second: 5, requestCount: 1, effectiveTokens: 120, tokenQuality: "exact" }),
                secondRecord({ second: 125, requestCount: 1, effectiveTokens: 180, tokenQuality: "estimated" }),
            ],
            { resolution: "minute", startSecond: 0, endSecond: 180 },
        )

        expect(points).toEqual([
            {
                bucketStartMs: 0,
                bucketEndMs: 60_000,
                activeSeconds: 1,
                requestCount: 1,
                tokenCount: 120,
                requestsPerMinute: 60,
                tokensPerMinute: 7_200,
                tokenQuality: "exact",
            },
            {
                bucketStartMs: 120_000,
                bucketEndMs: 180_000,
                activeSeconds: 1,
                requestCount: 1,
                tokenCount: 180,
                requestsPerMinute: 60,
                tokensPerMinute: 10_800,
                tokenQuality: "estimated",
            },
        ])
    })
})
