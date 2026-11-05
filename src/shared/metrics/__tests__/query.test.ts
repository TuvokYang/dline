import { describe, expect, it } from "vitest"
import { bucketStartOf } from "../bucket"
import type { UsageEvent } from "../events"
import { usageEventId } from "../identity"
import { accumulateUsage, emptyPerformanceRowBody, emptyUsageRow } from "../merge"
import { executionRpm, isPartialBucket, selectCoverage, totalsOfPerformance, totalsOfUsage, usageQueryResult } from "../query"
import type { PerformanceRow, UsageRow } from "../types"

const identity = {
    workspaceId: "workspace-a",
    taskId: "task-a",
    profileId: "profile-a",
    providerId: "anthropic",
    modelId: "model-a",
    keyFingerprint: "fingerprint-a",
    logicalRequestId: "logical-a",
    roundId: "round-a",
    sequence: 1,
}

function event(observedAtMs: number, overrides: Partial<UsageEvent> = {}): UsageEvent {
    return {
        ...identity,
        eventId: usageEventId("round-a"),
        kind: "usage",
        observedAtMs,
        inputTokens: 1000,
        outputTokens: 100,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        usageReported: true,
        costComplete: true,
        currencyMixed: false,
        usageQuality: "exact",
        ...overrides,
    }
}

function row(bucketStartMs: number, overrides: Partial<UsageRow> = {}): UsageRow {
    const body = accumulateUsage(
        emptyUsageRow(),
        event(bucketStartMs, {
            inputTokens: overrides.inputTokens ?? 1000,
            cacheWriteTokens: overrides.cacheWriteTokens,
            cacheReadTokens: overrides.cacheReadTokens,
            cost: overrides.cost,
            currency: overrides.currency,
        }),
    )
    return {
        scopeId: "task-a",
        resolution: "minute",
        bucketStartMs,
        modelId: "model-a",
        taskId: "task-a",
        profileId: "profile-a",
        keyFingerprint: "fingerprint-a",
        providerId: "anthropic",
        aggregatedAt: "2026-11-04T10:00:00.000Z",
        ...body,
        ...overrides,
    } as UsageRow
}

describe("weighted cache hit rate", () => {
    it("combines 90% of 1k with 10% of 99k as a weighted rate, not an arithmetic mean", () => {
        const small = row(bucketStartOf(0), { inputTokens: 100, cacheReadTokens: 900, cacheWriteTokens: 0 })
        const large = row(bucketStartOf(60_000), { inputTokens: 89_100, cacheReadTokens: 9_900, cacheWriteTokens: 0 })

        const totals = totalsOfUsage([small, large])

        // numerator 900 + 9900 = 10800 over denominator 1000 + 99000 = 100000
        expect(totals.cacheHitRate).toBeCloseTo(0.108, 10)
        expect(totals.cacheHitRate).not.toBeCloseTo(0.5, 2)
    })

    it("reports an unknown rate instead of 0% when nothing reported cache usage", () => {
        const totals = totalsOfUsage([row(bucketStartOf(0), { inputTokens: 500 })])

        expect(totals.cacheHitRate).toBeUndefined()
    })

    it("sums fresh and cache segments independently", () => {
        const totals = totalsOfUsage([
            row(bucketStartOf(0), { inputTokens: 100, cacheWriteTokens: 20, cacheReadTokens: 30 }),
            row(bucketStartOf(60_000), { inputTokens: 200, cacheWriteTokens: 40, cacheReadTokens: 60 }),
        ])

        expect(totals.inputTokens).toBe(300)
        expect(totals.cacheWriteTokens).toBe(60)
        expect(totals.cacheReadTokens).toBe(90)
    })
})

describe("coverage selection", () => {
    it("prefers the finer bucket and does not add a coarser bucket that covers it", () => {
        const minuteStart = bucketStartOf(Date.UTC(2026, 10, 4, 10, 23, 0), "minute")
        const hourStart = bucketStartOf(minuteStart, "hour")
        const minuteRow = row(minuteStart)

        const selected = selectCoverage(
            [
                { resolution: "minute", bucketStartMs: minuteStart, rows: [minuteRow] },
                { resolution: "hour", bucketStartMs: hourStart, rows: [row(hourStart)] },
            ],
            hourStart,
            hourStart + 3_600_000,
        )

        expect(selected).toHaveLength(1)
        expect(selected[0].resolution).toBe("minute")
    })

    it("keeps a gap instead of interpolating a missing bucket", () => {
        const first = bucketStartOf(Date.UTC(2026, 10, 4, 10, 0, 0), "hour")
        const second = bucketStartOf(Date.UTC(2026, 10, 4, 12, 0, 0), "hour")

        const selected = selectCoverage(
            [
                { resolution: "hour", bucketStartMs: first, rows: [row(first)] },
                { resolution: "hour", bucketStartMs: second, rows: [row(second)] },
            ],
            first,
            second + 3_600_000,
        )

        expect(selected.map((bucket) => bucket.bucketStartMs)).toEqual([first, second])
    })

    it("ignores buckets entirely outside the requested window", () => {
        const inside = bucketStartOf(Date.UTC(2026, 10, 4, 10, 0, 0), "hour")
        const outside = bucketStartOf(Date.UTC(2026, 10, 5, 10, 0, 0), "hour")

        const selected = selectCoverage(
            [
                { resolution: "hour", bucketStartMs: inside, rows: [row(inside)] },
                { resolution: "hour", bucketStartMs: outside, rows: [row(outside)] },
            ],
            inside,
            inside + 3_600_000,
        )

        expect(selected).toHaveLength(1)
        expect(selected[0].bucketStartMs).toBe(inside)
    })
})

describe("coarse bucket edges", () => {
    // An hour row holds the whole hour's numbers. When the caller asks for half of that
    // hour, adding the row would report the other half's usage as if it happened inside
    // the window, which is exactly the pseudo-allocation AC-18 forbids.
    it("calls a bucket that reaches outside the window partial", () => {
        const hourStart = Date.UTC(2026, 10, 4, 10, 0, 0)
        const bucket = { resolution: "hour" as const, bucketStartMs: hourStart }

        expect(isPartialBucket(bucket, hourStart, hourStart + 3_600_000)).toBe(false)
        expect(isPartialBucket(bucket, hourStart + 60_000, hourStart + 3_600_000)).toBe(true)
        expect(isPartialBucket(bucket, hourStart, hourStart + 1_800_000)).toBe(true)
    })

    it("counts a fully covered bucket and leaves an overlapping one out", () => {
        const hourStart = Date.UTC(2026, 10, 4, 10, 0, 0)
        const nextHour = hourStart + 3_600_000

        const covered = usageQueryResult({
            rows: [row(hourStart, { resolution: "hour" })],
            buckets: [{ resolution: "hour", bucketStartMs: hourStart, rows: [row(hourStart, { resolution: "hour" })] }],
            degraded: false,
            truncated: false,
            retrievedAt: "2026-11-04T10:30:00.000Z",
        })
        expect(covered.totals.inputTokens).toBe(1000)
        expect(covered.partialEdge).toBeUndefined()
        void nextHour
    })

    it("marks a result whose edge bucket was excluded", () => {
        const partial = usageQueryResult({
            rows: [],
            buckets: [],
            degraded: false,
            truncated: false,
            partialEdge: true,
            retrievedAt: "2026-11-04T10:30:00.000Z",
        })

        expect(partial.partialEdge).toBe(true)
        expect(partial.totals.inputTokens).toBe(0)
    })
})

describe("query result", () => {
    it("keeps each series point's own granularity", () => {
        const minuteStart = bucketStartOf(Date.UTC(2026, 10, 4, 10, 23, 0), "minute")
        const hourStart = bucketStartOf(Date.UTC(2026, 10, 4, 10, 0, 0), "hour")

        const result = usageQueryResult({
            rows: [row(minuteStart), row(hourStart)],
            buckets: [
                { resolution: "minute", bucketStartMs: minuteStart, rows: [row(minuteStart)] },
                { resolution: "hour", bucketStartMs: hourStart, rows: [row(hourStart)] },
            ],
            degraded: true,
            truncated: false,
            retrievedAt: "2026-11-04T10:30:00.000Z",
        })

        expect(result.series.map((point) => point.resolution)).toEqual(["hour", "minute"])
        expect(result.degraded).toBe(true)
        expect(result.retrievedAt).toBe("2026-11-04T10:30:00.000Z")
    })

    it("omits retention start rather than fabricating one", () => {
        const result = usageQueryResult({
            rows: [],
            buckets: [],
            degraded: false,
            truncated: false,
            retrievedAt: "2026-11-04T10:30:00.000Z",
        })

        expect(result.retentionStartMs).toBeUndefined()
        expect(result.totals.cacheHitRate).toBeUndefined()
    })
})

describe("performance totals", () => {
    function performanceRows(): PerformanceRow[] {
        const base = {
            scopeId: "task-a",
            resolution: "minute" as const,
            bucketStartMs: bucketStartOf(0),
            modelId: "model-a",
            taskId: "task-a",
            profileId: "profile-a",
            keyFingerprint: "fingerprint-a",
            providerId: "anthropic",
            aggregatedAt: "2026-11-04T10:00:00.000Z",
        }
        return [
            {
                ...base,
                ...emptyPerformanceRowBody(),
                factKind: "provider",
                providerDurationMs: 1000,
                requestCount: 1,
                providerRoundCount: 1,
                completedCount: 1,
                durationCoverage: 1,
                perfQuality: "exact",
            },
            {
                ...base,
                ...emptyPerformanceRowBody(),
                factKind: "execution",
                executionDurationMs: 2000,
                requestCount: 1,
                executionCount: 1,
                completedCount: 1,
                durationCoverage: 0,
                executionDurationCoverage: 1,
                perfQuality: "exact",
            },
        ]
    }

    // A provider attempt and a logical execution are different observations. Dividing
    // each sum by a shared counter would report 1000 ms over two samples as 500 ms and
    // 2000 ms over the same two as 1000 ms: both confidently wrong.
    it("averages provider and execution durations over their own samples", () => {
        const totals = totalsOfPerformance(performanceRows())

        expect(totals.durationCoverage).toBe(1)
        expect(totals.executionDurationCoverage).toBe(1)
        expect(totals.avgProviderDurationMs).toBeCloseTo(1000, 10)
        expect(totals.avgExecutionDurationMs).toBeCloseTo(2000, 10)
    })

    it("derives RPM from execution duration, not from provider rounds", () => {
        const totals = totalsOfPerformance(performanceRows())

        expect(totals.providerRoundCount).toBe(1)
        expect(totals.executionCount).toBe(1)
        expect(executionRpm(totals)).toBeCloseTo(30, 10)
    })

    it("leaves the average absent when no duration was recorded", () => {
        const totals = totalsOfPerformance([{ ...performanceRows()[0], providerDurationMs: 0, durationCoverage: 0 }])

        expect(totals.avgProviderDurationMs).toBeUndefined()
    })

    it("returns no RPM instead of dividing by an assumed minute", () => {
        const totals = totalsOfPerformance(performanceRows())

        expect(executionRpm({ ...totals, executionDurationMs: 0 })).toBeUndefined()
    })

    it("weights the TTFT mean by its own coverage, not by the duration divisor", () => {
        const [first, second] = performanceRows()
        // Two requests contributed a duration, but only one reported a TTFT. Dividing
        // 400 ms by 2 would report a confident 200 ms that nothing measured.
        const totals = totalsOfPerformance([
            { ...first, ttftMs: 400, ttftCoverage: 1, durationCoverage: 2 },
            { ...second, ttftMs: 0, ttftCoverage: 0 },
        ])

        expect(totals.ttftMs).toBe(400)
        expect(totals.ttftCoverage).toBe(1)
        expect(totals.avgTtftMs).toBeCloseTo(400, 10)
        // The provider mean keeps its own divisor: two provider samples, not three. The
        // execution row contributes to neither the provider divisor nor its duration.
        expect(totals.durationCoverage).toBe(2)
        expect(totals.avgProviderDurationMs).toBeCloseTo(1000 / 2, 10)
        expect(totals.executionDurationCoverage).toBe(1)
        expect(totals.avgExecutionDurationMs).toBeCloseTo(2000, 10)
    })

    it("leaves the TTFT mean absent when nothing reported it", () => {
        const totals = totalsOfPerformance(performanceRows())

        expect(totals.ttftCoverage).toBe(0)
        expect(totals.avgTtftMs).toBeUndefined()
    })
})
