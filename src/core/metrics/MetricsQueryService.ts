/**
 * Read-side access to a scope's committed metrics.
 *
 * Reads are deliberately *not* synchronous with writes: they return whatever has
 * already been committed and report when it was read. A surface that hides that age
 * would show a chart that silently lags behind the truth, and a reader that waited for
 * a flush would put database latency back on the Task's UI path.
 */

import { bucketStartOf, RESOLUTION_MS, RESOLUTIONS_BY_INCREASING_WIDTH } from "@shared/metrics/bucket"
import { accumulatePerformanceTotals, accumulateUsageTotals } from "@shared/metrics/merge"
import { emptyPerformanceTotals, emptyUsageTotals, isPartialBucket, seriesOfUsage, usageQueryResult } from "@shared/metrics/query"
import type {
    MetricsResolution,
    PerformanceRow,
    PerformanceTotals,
    UsageQueryResult,
    UsageRow,
    UsageTotals,
} from "@shared/metrics/types"
import type { MetricsHealthSnapshot } from "./MetricsHealth"
import type { MetricsReadOptions } from "./MetricsLedger"

/** The read capability a repository exposes; the query service only needs this. */
export interface MetricsReadPort {
    usage(options?: MetricsReadOptions): Promise<UsageRow[]>
    performance(options?: MetricsReadOptions): Promise<PerformanceRow[]>
    acceptanceFloorMs(): Promise<number | undefined>
}

export interface MetricsQueryServiceOptions {
    readonly reads: MetricsReadPort
    /** Health probe, so a degraded answer can say so instead of looking complete. */
    readonly health?: () => MetricsHealthSnapshot
    readonly now?: () => number
}

/** One scope's read surface. */
export class MetricsQueryService {
    private readonly reads: MetricsReadPort
    private readonly health: (() => MetricsHealthSnapshot) | undefined
    private readonly now: () => number

    constructor(options: MetricsQueryServiceOptions) {
        this.reads = options.reads
        this.health = options.health
        this.now = options.now ?? Date.now
    }

    /**
     * Usage totals over a window.
     *
     * Rows are reduced onto totals with the shared accumulator, so a returned cache
     * rate is Σnum/Σden rather than an average of averages, and a partially known cost
     * stays identifiable as partial.
     */
    async usageTotals(options: MetricsReadOptions = {}): Promise<UsageTotals> {
        const rows = await this.reads.usage(options)
        const totals = rows.reduce<UsageTotals>((base, row) => accumulateUsageTotals(base, row), emptyUsageTotals())
        return withCacheRate(totals, rows)
    }

    /** Performance totals over a window, at the requested granularity. */
    async performanceTotals(options: MetricsReadOptions = {}): Promise<PerformanceTotals> {
        const rows = await this.reads.performance(options)
        return rows.reduce<PerformanceTotals>((base, row) => accumulatePerformanceTotals(base, row), emptyPerformanceTotals())
    }

    /**
     * A usage series plus its totals.
     *
     * `resolution` narrows the read to one physical granularity instead of mixing a
     * rolled-up hour with the minutes it replaced.
     */
    async usageSeries(options: MetricsQueryOptions = {}): Promise<UsageQueryResult> {
        const window = windowOf(options)
        const rows = await this.reads.usage({ ...readOptionsOf(options), ...coveringReadWindow(options, window) })
        const buckets = bucketize(rows, options.resolution)
        // A bucket that reaches outside the requested window cannot be split: its stored
        // numbers are the whole bucket. Counting it would attribute the whole bucket to a
        // narrower window, so only a bucket fully inside the window contributes to the
        // totals. The window itself is what the caller asked for; without one, every row
        // is inside it by definition.
        const contributing = window ? buckets.filter((bucket) => !isPartialBucket(bucket, window.startMs, window.endMs)) : buckets
        const partialEdge = buckets.some(
            (bucket) => window !== undefined && isPartialBucket(bucket, window.startMs, window.endMs),
        )
        const ordered = seriesOfUsage(contributing)
        const maxPoints = options.maxPoints
        const truncated = maxPoints !== undefined && ordered.length > maxPoints
        const limitedBuckets =
            truncated && maxPoints !== undefined ? contributing.slice(contributing.length - maxPoints) : contributing
        const retentionStartMs = await this.reads.acceptanceFloorMs()
        const health = this.health?.()
        return usageQueryResult({
            rows: contributing.flatMap((bucket) => bucket.rows),
            buckets: limitedBuckets,
            truncated,
            degraded: health?.state === "degraded" || health?.lostEvents === true,
            retrievedAt: new Date(this.now()).toISOString(),
            // Saying a coarse bucket was excluded is the honest answer: the totals do not
            // include it, and a caller that needs a complete figure must widen the window.
            ...(partialEdge ? { partialEdge: true } : {}),
            ...(retentionStartMs === undefined ? {} : { retentionStartMs }),
        })
    }

    /** The coarsest resolution that has any committed row, or `undefined` when empty. */
    async availableResolutions(): Promise<readonly MetricsResolution[]> {
        const rows = await this.reads.usage()
        const present = new Set(rows.map((row) => row.resolution))
        return RESOLUTIONS_BY_INCREASING_WIDTH.filter((resolution) => present.has(resolution))
    }
}

export interface MetricsQueryOptions extends MetricsReadOptions {
    readonly resolution?: MetricsResolution
    readonly maxPoints?: number
}

function readOptionsOf(options: MetricsQueryOptions): MetricsReadOptions {
    const { resolution: _resolution, maxPoints: _maxPoints, ...readOptions } = options
    return readOptions
}

/** The queried window, present only when the caller bounded both ends. */
function windowOf(options: MetricsQueryOptions): { readonly startMs: number; readonly endMs: number } | undefined {
    const { fromMs, toMs } = options
    return fromMs === undefined || toMs === undefined || toMs <= fromMs ? undefined : { startMs: fromMs, endMs: toMs }
}

/**
 * Widen a read window so a coarse bucket that overlaps an edge is still returned.
 *
 * The Ledger selects by `bucketStartMs`, so a bucket starting before `fromMs` is
 * invisible even when it covers part of the window. Reading from the widest
 * resolution's start keeps that bucket available for `isPartialBucket` to reject;
 * without it the edge looks fully covered and `partialEdge` would never be reported.
 */
function coveringReadWindow(
    options: MetricsQueryOptions,
    window: { readonly startMs: number; readonly endMs: number } | undefined,
): { readonly fromMs?: number; readonly toMs?: number } {
    const fromMs = window === undefined ? options.fromMs : window.startMs - WIDEST_RESOLUTION_MS
    const toMs = window === undefined ? options.toMs : window.endMs + WIDEST_RESOLUTION_MS
    return {
        ...(fromMs === undefined ? {} : { fromMs }),
        ...(toMs === undefined ? {} : { toMs }),
    }
}

/** The widest bucket a query may return, whose span bounds how far a read must widen. */
const WIDEST_RESOLUTION_MS = Math.max(...Object.values(RESOLUTION_MS))

/**
 * Derive the hit rate from the accumulated numerator and denominator.
 *
 * This is the only place the rate is computed; storing it would freeze a ratio that
 * cannot be recombined with another bucket.
 */
function withCacheRate(totals: UsageTotals, rows: readonly UsageRow[]): UsageTotals {
    let numerator = 0
    let denominator = 0
    let anyCache = false
    for (const row of rows) {
        if (!row.cacheUsageAvailable) continue
        anyCache = true
        numerator += row.cacheNumerator
        denominator += row.cacheDenominator
    }
    if (!anyCache || denominator <= 0) return totals
    return { ...totals, cacheHitRate: numerator / denominator }
}

/**
 * Group rows into physical buckets.
 *
 * A row already belongs to exactly one bucket, so this only assembles the grouping the
 * series projection expects; it never re-buckets a value into a different granularity.
 */
function bucketize(
    rows: readonly UsageRow[],
    resolution: MetricsResolution | undefined,
): import("@shared/metrics/query").ResolutionBucket[] {
    const groups = new Map<string, { resolution: MetricsResolution; bucketStartMs: number; rows: UsageRow[] }>()
    for (const row of rows) {
        if (resolution !== undefined && row.resolution !== resolution) continue
        const key = `${row.resolution}\u0000${row.bucketStartMs}`
        const existing = groups.get(key)
        if (existing) existing.rows.push(row)
        else groups.set(key, { resolution: row.resolution, bucketStartMs: row.bucketStartMs, rows: [row] })
    }
    return [...groups.values()]
}

/** The bucket start a query covers, used by callers that label a chart axis. */
export function queryBucketStart(fromMs: number, resolution: MetricsResolution): number {
    return bucketStartOf(fromMs, resolution)
}
