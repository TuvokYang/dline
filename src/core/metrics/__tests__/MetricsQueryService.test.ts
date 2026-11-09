import { executionRpm } from "@shared/metrics/query"
import type { UsageRow } from "@shared/metrics/types"
import { describe, expect, it } from "vitest"
import { MetricsQueryService, type MetricsReadPort } from "../MetricsQueryService"

const T0 = Date.UTC(2026, 0, 2, 3, 4, 0)
const MINUTE = 60_000

function usageRow(overrides: Partial<UsageRow> = {}): UsageRow {
    return {
        scopeId: "task-a",
        resolution: "minute",
        bucketStartMs: T0,
        modelId: "model-a",
        taskId: "task-a",
        profileId: "profile-a",
        keyFingerprint: "fp",
        providerId: "provider-a",
        inputTokens: 0,
        outputTokens: 0,
        thoughtsTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        cacheNumerator: 0,
        cacheDenominator: 0,
        usageAvailable: true,
        cacheUsageAvailable: false,
        currencyMixed: false,
        costAvailable: false,
        usageQuality: "exact",
        respondingRequests: 1,
        aggregatedAt: new Date(T0).toISOString(),
        ...overrides,
    }
}

class RowsReadPort implements MetricsReadPort {
    constructor(
        private readonly usageRows: UsageRow[],
        private readonly floorMs: number | undefined = undefined,
    ) {}

    /** Mirrors the Ledger's bucketStart filter, so a test cannot pass on rows a real read would drop. */
    async usage(options: { readonly fromMs?: number; readonly toMs?: number } = {}) {
        return this.usageRows.filter(
            (row) =>
                (options.fromMs === undefined || row.bucketStartMs >= options.fromMs) &&
                (options.toMs === undefined || row.bucketStartMs < options.toMs),
        )
    }

    async performance() {
        return []
    }

    async acceptanceFloorMs() {
        return this.floorMs
    }
}

describe("MetricsQueryService", () => {
    it("derives the cache rate from the accumulated ratio instead of averaging", async () => {
        const service = new MetricsQueryService({
            reads: new RowsReadPort([
                usageRow({
                    bucketStartMs: T0,
                    cacheUsageAvailable: true,
                    cacheNumerator: 900,
                    cacheDenominator: 1_000,
                }),
                usageRow({
                    bucketStartMs: T0 + MINUTE,
                    cacheUsageAvailable: true,
                    cacheNumerator: 9_900,
                    cacheDenominator: 99_000,
                }),
            ]),
        })

        const totals = await service.usageTotals()
        expect(totals.cacheHitRate).toBeCloseTo(10_800 / 100_000, 10)
    })

    it("reports no rate when nothing reported cache usage", async () => {
        const service = new MetricsQueryService({
            reads: new RowsReadPort([usageRow({ cacheUsageAvailable: false, cacheNumerator: 5, cacheDenominator: 10 })]),
        })
        expect((await service.usageTotals()).cacheHitRate).toBeUndefined()
    })

    it("keeps an incomplete cost distinguishable from a complete total", async () => {
        const service = new MetricsQueryService({
            reads: new RowsReadPort([
                usageRow({ bucketStartMs: T0, cost: 1, currency: "USD", costAvailable: false }),
                usageRow({ bucketStartMs: T0 + MINUTE, cost: 2, currency: "USD", costAvailable: false }),
            ]),
        })

        const totals = await service.usageTotals()
        expect(totals.costAvailable).toBe(false)
    })

    it("never adds two currencies into one total", async () => {
        const service = new MetricsQueryService({
            reads: new RowsReadPort([
                usageRow({ bucketStartMs: T0, cost: 1, currency: "USD", costAvailable: true }),
                usageRow({ bucketStartMs: T0 + MINUTE, cost: 7, currency: "CNY", costAvailable: true }),
            ]),
        })

        const totals = await service.usageTotals()
        expect(totals.currencyMixed).toBe(true)
        expect(totals.cost).toBeUndefined()
        expect(totals.costAvailable).toBe(false)
    })

    it("narrows the series to the requested resolution", async () => {
        const service = new MetricsQueryService({
            reads: new RowsReadPort([
                usageRow({ resolution: "minute", bucketStartMs: T0, inputTokens: 10 }),
                usageRow({ resolution: "hour", bucketStartMs: T0, inputTokens: 100 }),
            ]),
            now: () => T0,
        })

        const hourly = await service.usageSeries({ resolution: "hour" })
        expect(hourly.series.map((point) => [point.resolution, point.inputTokens])).toEqual([["hour", 100]])

        const everything = await service.usageSeries()
        expect(everything.series).toHaveLength(2)
    })

    // AC-18: an hour row covers the whole hour. Asking for a narrower window must not
    // count it, because the row's numbers include time outside that window; the result
    // says an edge bucket was skipped so a caller can widen the window instead.
    it("excludes a bucket that reaches outside the window and reports the partial edge", async () => {
        const hourStart = T0
        const service = new MetricsQueryService({
            reads: new RowsReadPort([usageRow({ resolution: "hour", bucketStartMs: hourStart, inputTokens: 1000 })]),
            now: () => T0,
        })

        const whole = await service.usageSeries({ fromMs: hourStart, toMs: hourStart + 3_600_000 })
        expect(whole.totals.inputTokens).toBe(1000)
        expect(whole.partialEdge).toBeUndefined()

        const half = await service.usageSeries({ fromMs: hourStart + MINUTE, toMs: hourStart + 3_600_000 })
        expect(half.totals.inputTokens).toBe(0)
        expect(half.series).toEqual([])
        expect(half.partialEdge).toBe(true)
    })

    it("keeps a fully covered fine bucket when a coarse bucket overlaps the edge", async () => {
        const hourStart = T0
        const service = new MetricsQueryService({
            reads: new RowsReadPort([
                usageRow({ resolution: "hour", bucketStartMs: hourStart, inputTokens: 1000 }),
                usageRow({ resolution: "minute", bucketStartMs: hourStart + MINUTE, inputTokens: 7 }),
            ]),
            now: () => T0,
        })

        const result = await service.usageSeries({ fromMs: hourStart + MINUTE, toMs: hourStart + 3_600_000 })
        // The minute row lies inside the window, so it counts; the hour row does not.
        expect(result.totals.inputTokens).toBe(7)
        expect(result.series.map((point) => point.resolution)).toEqual(["minute"])
        expect(result.partialEdge).toBe(true)
    })

    // The Ledger selects by bucketStart, so a bucket that starts before the window is
    // invisible unless the read widens. This asserts the widened read, not just the
    // filter: with the narrow read the row never arrives and the result would falsely
    // claim the window was fully covered.
    it("reports a left-edge coarse bucket that the narrow read would have hidden", async () => {
        const hourStart = T0
        const service = new MetricsQueryService({
            reads: new RowsReadPort([usageRow({ resolution: "hour", bucketStartMs: hourStart, inputTokens: 1000 })]),
            now: () => T0,
        })

        const result = await service.usageSeries({ fromMs: hourStart + MINUTE, toMs: hourStart + 30 * MINUTE })
        expect(result.totals.inputTokens).toBe(0)
        expect(result.series).toEqual([])
        expect(result.partialEdge).toBe(true)
    })

    it("truncates to the newest points and says so", async () => {
        const service = new MetricsQueryService({
            reads: new RowsReadPort([
                usageRow({ bucketStartMs: T0, inputTokens: 1 }),
                usageRow({ bucketStartMs: T0 + MINUTE, inputTokens: 2 }),
                usageRow({ bucketStartMs: T0 + 2 * MINUTE, inputTokens: 3 }),
            ]),
            now: () => T0,
        })

        const result = await service.usageSeries({ maxPoints: 2 })
        expect(result.truncated).toBe(true)
        expect(result.series.map((point) => point.inputTokens)).toEqual([2, 3])
    })

    it("reports degradation and the retention start instead of hiding them", async () => {
        const service = new MetricsQueryService({
            reads: new RowsReadPort([usageRow()], T0 - MINUTE),
            now: () => T0,
            health: () => ({
                state: "degraded",
                consecutiveFailures: 3,
                lostEvents: true,
                queue: { pending: 0, accepted: 0, dropped: { queue_full: 1, scope_closed: 0, receiver_failed: 0 } },
            }),
        })

        const result = await service.usageSeries()
        expect(result.degraded).toBe(true)
        expect(result.retentionStartMs).toBe(T0 - MINUTE)
        expect(result.retrievedAt).toBe(new Date(T0).toISOString())
    })

    it("lists only the resolutions that actually hold rows", async () => {
        const service = new MetricsQueryService({
            reads: new RowsReadPort([usageRow({ resolution: "hour" }), usageRow({ resolution: "minute" })]),
        })
        expect(await service.availableResolutions()).toEqual(["minute", "hour"])
    })

    it("computes execution RPM from logical executions, not provider rounds", () => {
        expect(
            executionRpm({
                providerDurationMs: 0,
                executionDurationMs: 30_000,
                generationDurationMs: 0,
                ttftMs: 0,
                requestCount: 0,
                completedCount: 0,
                failedCount: 0,
                cancelledCount: 0,
                abortedCount: 0,
                providerRoundCount: 7,
                executionCount: 3,
                perfQuality: "exact",
                durationCoverage: 1,
                executionDurationCoverage: 1,
                ttftCoverage: 0,
            }),
        ).toBeCloseTo(6, 10)
    })
})
