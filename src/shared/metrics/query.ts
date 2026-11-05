/**
 * Read-side projections over stored rows.
 *
 * Queries never wait for a write and never invent precision: a missing finer bucket
 * is reported as missing rather than smeared proportionally out of a coarser one.
 */

import { RESOLUTION_MS, RESOLUTIONS_BY_INCREASING_WIDTH } from "./bucket"
import { accumulatePerformanceTotals, accumulateUsageTotals } from "./merge"
import type {
    MetricsResolution,
    PerformanceRow,
    PerformanceTotals,
    UsageQueryResult,
    UsageRow,
    UsageSeriesPoint,
    UsageTotals,
} from "./types"

/** A totals accumulator that has not seen a row yet. */
export function emptyUsageTotals(): UsageTotals {
    return {
        inputTokens: 0,
        outputTokens: 0,
        thoughtsTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        cacheHitRate: undefined,
        cost: undefined,
        currency: undefined,
        currencyMixed: false,
        costAvailable: false,
        usageQuality: "none",
        respondingRequests: 0,
    }
}

/** A performance totals accumulator that has not seen a row yet. */
export function emptyPerformanceTotals(): PerformanceTotals {
    return {
        providerDurationMs: 0,
        executionDurationMs: 0,
        generationDurationMs: 0,
        ttftMs: 0,
        requestCount: 0,
        completedCount: 0,
        failedCount: 0,
        cancelledCount: 0,
        abortedCount: 0,
        providerRoundCount: 0,
        executionCount: 0,
        perfQuality: "unknown",
        durationCoverage: 0,
        executionDurationCoverage: 0,
        ttftCoverage: 0,
        avgProviderDurationMs: undefined,
        avgExecutionDurationMs: undefined,
        avgTtftMs: undefined,
    }
}

/**
 * Sum usage rows into totals.
 *
 * The cache rate is `Σnumerator / Σdenominator`, which is why `90% of 1k` and
 * `10% of 99k` combine to `10%`-and-a-bit instead of the arithmetic mean of the two
 * percentages. An empty denominator yields `undefined` — "no cache data", not `0%`.
 */
export function totalsOfUsage(rows: readonly UsageRow[]): UsageTotals {
    let totals = emptyUsageTotals()
    let numerator = 0
    let denominator = 0
    for (const row of rows) {
        totals = accumulateUsageTotals(totals, row)
        numerator += row.cacheNumerator
        denominator += row.cacheDenominator
    }
    return withCacheRate(totals, numerator, denominator)
}

/** Derive the cache rate from accumulated numerator/denominator. */
export function withCacheRate(totals: UsageTotals, numerator: number, denominator: number): UsageTotals {
    return { ...totals, cacheHitRate: denominator === 0 ? undefined : numerator / denominator }
}

/**
 * Sum performance rows into totals.
 *
 * The averages come from the accumulator, which divides each mean by its own coverage
 * count. Re-deriving them here from `durationCoverage` would give TTFT the duration
 * divisor and report `0 ms` for requests that never reported one.
 */
export function totalsOfPerformance(rows: readonly PerformanceRow[]): PerformanceTotals {
    let totals = emptyPerformanceTotals()
    for (const row of rows) totals = accumulatePerformanceTotals(totals, row)
    return totals
}

/** Requests per minute from logical executions; `undefined` when no duration was
 * recorded, because dividing by an assumed minute would fabricate throughput. */
export function executionRpm(totals: PerformanceTotals): number | undefined {
    if (totals.executionDurationMs <= 0) return undefined
    return (totals.executionCount / totals.executionDurationMs) * 60_000
}

/** One bucket of a series, tagged with the granularity it was stored at. */
export interface ResolutionBucket {
    readonly resolution: MetricsResolution
    readonly bucketStartMs: number
    readonly rows: readonly UsageRow[]
}

/**
 * Choose a non-overlapping set of buckets covering `[startMs, endMs)`.
 *
 * Finer granularity wins where it exists. A minute bucket is only skipped when an
 * enclosing bucket at the same or coarser resolution already covers that instant,
 * which is what prevents summing a rolled-up hour row together with the minute rows
 * it replaced. A gap stays a gap: nothing is interpolated.
 */
export function selectCoverage(buckets: readonly ResolutionBucket[], startMs: number, endMs: number): ResolutionBucket[] {
    const ordered = [...buckets].sort((left, right) => {
        const widthDelta = RESOLUTION_MS[left.resolution] - RESOLUTION_MS[right.resolution]
        return widthDelta !== 0 ? widthDelta : left.bucketStartMs - right.bucketStartMs
    })

    const selected: ResolutionBucket[] = []
    const claimed: Array<{ start: number; end: number }> = []
    for (const bucket of ordered) {
        const start = Math.max(bucket.bucketStartMs, startMs)
        const end = Math.min(bucket.bucketStartMs + RESOLUTION_MS[bucket.resolution], endMs)
        if (end <= start) continue
        if (claimed.some((range) => overlaps(range.start, range.end, start, end))) continue
        claimed.push({ start, end })
        selected.push(bucket)
    }
    return selected.sort(bySeriesOrder)
}

/**
 * Series order: time first, then finest granularity.
 *
 * Selection order is finest-first so a fine bucket claims its range before a coarse
 * one; the series a caller plots must still read left to right, so the two orders are
 * deliberately different.
 */
function bySeriesOrder(left: ResolutionBucket, right: ResolutionBucket): number {
    if (left.bucketStartMs !== right.bucketStartMs) return left.bucketStartMs - right.bucketStartMs
    return RESOLUTION_MS[left.resolution] - RESOLUTION_MS[right.resolution]
}

function overlaps(leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): boolean {
    return leftStart < rightEnd && rightStart < leftEnd
}

/**
 * Whether a bucket reaches outside the queried window.
 *
 * A partial bucket is the coarse-edge case: its stored numbers cover the whole bucket,
 * so counting them for a narrower window would attribute part of the total to time the
 * caller did not ask about. The caller must report this rather than silently prorate.
 */
export function isPartialBucket(
    bucket: Pick<ResolutionBucket, "resolution" | "bucketStartMs">,
    startMs: number,
    endMs: number,
): boolean {
    const end = bucket.bucketStartMs + RESOLUTION_MS[bucket.resolution]
    return bucket.bucketStartMs < startMs || end > endMs
}

/**
 * Project buckets into a series, each point carrying its own granularity.
 *
 * The `resolution` on a point is what stops a caller from comparing a minute point
 * with an hour point as if they were the same measurement. Points are ordered by
 * time so a caller can plot them directly, whatever order selection produced.
 */
export function seriesOfUsage(buckets: readonly ResolutionBucket[]): UsageSeriesPoint[] {
    return [...buckets].sort(bySeriesOrder).map((bucket) => ({
        resolution: bucket.resolution,
        bucketStartMs: bucket.bucketStartMs,
        ...totalsOfUsage(bucket.rows),
    }))
}

/** The result a degraded or timeout-bound read returns: real numbers with honest
 * completeness flags rather than a silent empty answer. */
export function usageQueryResult(input: {
    readonly rows: readonly UsageRow[]
    readonly buckets: readonly ResolutionBucket[]
    readonly degraded: boolean
    readonly truncated: boolean
    readonly retentionStartMs?: number
    readonly partialEdge?: boolean
    readonly retrievedAt: string
}): UsageQueryResult {
    return {
        totals: totalsOfUsage(input.rows),
        series: seriesOfUsage(input.buckets),
        degraded: input.degraded,
        truncated: input.truncated,
        ...(input.retentionStartMs === undefined ? {} : { retentionStartMs: input.retentionStartMs }),
        ...(input.partialEdge === true ? { partialEdge: true } : {}),
        retrievedAt: input.retrievedAt,
    }
}

/** Resolutions a query may request, finest first. */
export const QUERYABLE_RESOLUTIONS: readonly MetricsResolution[] = RESOLUTIONS_BY_INCREASING_WIDTH
