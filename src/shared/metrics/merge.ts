/**
 * Row accumulation.
 *
 * These functions implement the arithmetic rules that make stored numbers addable
 * across buckets: derived values (cache rate, averages) are never stored, unknown is
 * never turned into zero, and a partial cost never becomes a complete total.
 */

import type { PerformanceEvent, UsageEvent } from "./events"
import type {
    MetricsQuality,
    MetricsRowIdentity,
    PerformanceFactKind,
    PerformanceQuality,
    PerformanceRow,
    PerformanceTotals,
    UsageQuality,
    UsageRow,
    UsageTotals,
} from "./types"

/** A usage row without its identity columns, which the receiver supplies. */
export type UsageBody = Omit<UsageRow, keyof MetricsRowIdentity | "providerId" | "aggregatedAt">

/** A performance row without its identity columns and fact kind. */
export type PerformanceBody = Omit<PerformanceRow, keyof MetricsRowIdentity | "providerId" | "factKind" | "aggregatedAt">

/**
 * A zero-valued usage row body, before any event has contributed.
 *
 * `costAvailable` starts `true` with no `cost`: the sum over zero contributors is
 * vacuously complete, and the absence of a value still means "nothing reported".
 * That is what lets the first contribution decide completeness instead of inheriting
 * a pessimistic empty state.
 */
export function emptyUsageRow(): UsageBody {
    return {
        inputTokens: 0,
        outputTokens: 0,
        thoughtsTokens: 0,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        cacheNumerator: 0,
        cacheDenominator: 0,
        usageAvailable: false,
        cacheUsageAvailable: false,
        cost: undefined,
        currency: undefined,
        currencyMixed: false,
        costAvailable: true,
        usageQuality: "none",
        respondingRequests: 0,
    }
}

/** A zero-valued performance row body for one fact kind. */
export function emptyPerformanceRowBody(): PerformanceBody {
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
    }
}

/**
 * Coarse-to-fine quality promotion used by both tables.
 *
 * `mixed` outranks every other label because it records that contributors disagreed,
 * which no amount of further accumulation can repair.
 */
function mergeQuality(current: MetricsQuality, next: MetricsQuality): MetricsQuality {
    const rank: Record<MetricsQuality, number> = { none: 0, estimated: 1, exact: 2, mixed: 3 }
    return rank[next] > rank[current] ? next : current
}

/** Usage keeps `legacy` distinguishable from `estimated`, so it ranks as its own label. */
function mergeUsageQuality(current: UsageQuality, next: UsageQuality): UsageQuality {
    if (current === "legacy" || next === "legacy")
        return current === next ? "legacy" : mergeQuality(legacyAsBase(current), legacyAsBase(next))
    return mergeQuality(current, next)
}

/** `legacy` contributes at `estimated` strength when combined with a non-legacy value. */
function legacyAsBase(quality: UsageQuality): MetricsQuality {
    return quality === "legacy" ? "estimated" : quality
}

/**
 * Add one usage event onto a bucket.
 *
 * Cache accounting: the numerator counts cache reads, the denominator counts the full
 * context (`fresh + cacheWrite + cacheRead`) so a stored ratio could never be averaged
 * across buckets. Absence of a cache segment is not zero — it only becomes a zero
 * contribution once the Provider actually reported cache usage.
 */
export function accumulateUsage(base: UsageBody, event: UsageEvent): UsageBody {
    if (!event.usageReported) {
        // A request that reported nothing is still a real request; it just contributes
        // no numbers and cannot promote the bucket's quality.
        return { ...base, usageQuality: base.usageQuality === "none" ? "none" : base.usageQuality }
    }

    const inputTokens = base.inputTokens + event.inputTokens
    const outputTokens = base.outputTokens + event.outputTokens
    const thoughtsTokens = base.thoughtsTokens + (event.thoughtsTokens ?? 0)
    const cacheWriteTokens = base.cacheWriteTokens + (event.cacheWriteTokens ?? 0)
    const cacheReadTokens = base.cacheReadTokens + (event.cacheReadTokens ?? 0)
    const cacheReported = event.cacheWriteTokens !== undefined || event.cacheReadTokens !== undefined
    const cacheNumerator = base.cacheNumerator + (event.cacheReadTokens ?? 0)
    const cacheDenominator = base.cacheDenominator + (cacheReported ? inputTokensFor(event) : 0)
    const costs = mergeCost(base, event)

    return {
        inputTokens,
        outputTokens,
        thoughtsTokens,
        cacheWriteTokens,
        cacheReadTokens,
        cacheNumerator,
        cacheDenominator,
        usageAvailable: true,
        cacheUsageAvailable: base.cacheUsageAvailable || cacheReported,
        cost: costs.cost,
        currency: costs.currency,
        currencyMixed: costs.currencyMixed,
        costAvailable: costs.costAvailable,
        usageQuality: mergeUsageQuality(base.usageQuality, event.usageQuality),
        respondingRequests: base.respondingRequests + 1,
    }
}

/** The cache denominator contribution of one event: fresh input plus both cache segments. */
function inputTokensFor(event: UsageEvent): number {
    return event.inputTokens + (event.cacheWriteTokens ?? 0) + (event.cacheReadTokens ?? 0)
}

interface CostAccumulation {
    readonly cost?: number
    readonly currency?: string
    readonly currencyMixed: boolean
    readonly costAvailable: boolean
}

/**
 * Combine a bucket's cost with one event's cost.
 *
 * Only complete, same-currency totals are added. A known partial subtotal is kept as
 * a non-complete value so a surface can show "some cost known" without ever printing
 * it as the total. A source-confirmed currency conflict is preserved as `mixed`
 * instead of being degraded to plain unknown.
 */
function mergeCost(
    base: Pick<UsageRow, "cost" | "currency" | "currencyMixed" | "costAvailable">,
    event: UsageEvent,
): CostAccumulation {
    const mixed = base.currencyMixed || event.currencyMixed
    if (mixed) {
        // A conflict is a fact about the bucket; it must not be replaced by a later
        // value that happens to look consistent.
        return { cost: undefined, currency: undefined, currencyMixed: true, costAvailable: false }
    }
    if (event.cost === undefined) {
        // An unknown contribution means the bucket total is unknown, even if earlier
        // contributions were complete. `costAvailable` stays false from here on, which is
        // also what tells the next contribution it is *not* the first one.
        return { cost: undefined, currency: base.currency, currencyMixed: false, costAvailable: false }
    }
    if (base.cost === undefined && base.costAvailable) {
        // First contribution: the bucket is complete exactly when this event is.
        // A bucket that already recorded an unknown contribution has `costAvailable`
        // false, so a later complete value cannot turn the total into a complete one.
        return { cost: event.cost, currency: event.currency, currencyMixed: false, costAvailable: event.costComplete }
    }
    if (base.cost === undefined) {
        // The subtotal was lost to an unknown contribution: keep this value visible but
        // never report it as the bucket's complete total.
        return { cost: event.cost, currency: event.currency, currencyMixed: false, costAvailable: false }
    }
    if (
        base.cost !== undefined &&
        base.currency !== undefined &&
        event.currency !== undefined &&
        base.currency !== event.currency
    ) {
        return { cost: undefined, currency: undefined, currencyMixed: true, costAvailable: false }
    }

    const currency = base.currency ?? event.currency
    const summed = (base.cost ?? 0) + event.cost
    if (base.costAvailable && event.costComplete) {
        return { cost: summed, currency, currencyMixed: false, costAvailable: true }
    }
    // A complete total needs every contributor complete; otherwise keep the subtotal
    // as an explicitly incomplete value.
    return { cost: summed, currency, currencyMixed: false, costAvailable: false }
}

/**
 * Add one performance event onto a bucket.
 *
 * Provider rounds and logical executions increment separate counters so an RPM
 * projection can keep using execution duration as its denominator. Durations add
 * per contributing request, and `durationCoverage` counts those requests.
 */
export function accumulatePerformance(base: PerformanceBody, event: PerformanceEvent): PerformanceBody {
    const isExecution = event.factKind === "execution"
    const duration = isExecution ? event.executionDurationMs : event.providerDurationMs
    return {
        providerDurationMs: base.providerDurationMs + (event.providerDurationMs ?? 0),
        executionDurationMs: base.executionDurationMs + (event.executionDurationMs ?? 0),
        generationDurationMs: base.generationDurationMs + (event.generationDurationMs ?? 0),
        ttftMs: base.ttftMs + (event.ttftMs ?? 0),
        requestCount: base.requestCount + 1,
        completedCount: base.completedCount + (event.status === "completed" ? 1 : 0),
        failedCount: base.failedCount + (event.status === "failed" ? 1 : 0),
        cancelledCount: base.cancelledCount + (event.status === "cancelled" ? 1 : 0),
        abortedCount: base.abortedCount + (event.status === "aborted" ? 1 : 0),
        providerRoundCount: base.providerRoundCount + (isExecution ? 0 : 1),
        executionCount: base.executionCount + (isExecution ? 1 : 0),
        perfQuality: mergePerformanceQuality(base.perfQuality, event.perfQuality),
        // Each average is divided by its own samples. One counter shared by both kinds
        // would report a provider duration over provider *and* execution attempts.
        durationCoverage: base.durationCoverage + (!isExecution && duration !== undefined ? 1 : 0),
        executionDurationCoverage: base.executionDurationCoverage + (isExecution && duration !== undefined ? 1 : 0),
        ttftCoverage: base.ttftCoverage + (event.ttftMs === undefined ? 0 : 1),
    }
}

function mergePerformanceQuality(current: PerformanceQuality, next: PerformanceQuality): PerformanceQuality {
    const rank: Record<PerformanceQuality, number> = { unknown: 0, estimated: 1, exact: 2, mixed: 3 }
    return rank[next] > rank[current] ? next : current
}

/** Add one usage row onto a totals accumulator. */
export function accumulateUsageTotals(base: UsageTotals, row: UsageRow): UsageTotals {
    const mixed = base.currencyMixed || row.currencyMixed
    const currencyConflict = !mixed && base.currency !== undefined && row.currency !== undefined && base.currency !== row.currency
    const canAddCost = !mixed && !currencyConflict && row.cost !== undefined
    // A totals accumulator starts with `costAvailable: false` and no cost. That is a
    // "nothing seen yet" state, not a contribution, so the first real row may establish
    // completeness. Once any row is incomplete or conflicting, the total stays incomplete.
    const isFirstContribution = base.respondingRequests === 0 && base.cost === undefined
    return {
        inputTokens: base.inputTokens + row.inputTokens,
        outputTokens: base.outputTokens + row.outputTokens,
        thoughtsTokens: base.thoughtsTokens + row.thoughtsTokens,
        cacheWriteTokens: base.cacheWriteTokens + row.cacheWriteTokens,
        cacheReadTokens: base.cacheReadTokens + row.cacheReadTokens,
        cacheHitRate: undefined,
        cost: canAddCost ? (base.cost ?? 0) + (row.cost as number) : undefined,
        currency: mixed || currencyConflict ? undefined : (base.currency ?? row.currency),
        currencyMixed: mixed || currencyConflict,
        costAvailable: isFirstContribution
            ? !mixed && !currencyConflict && row.costAvailable && row.cost !== undefined
            : !mixed &&
              !currencyConflict &&
              base.costAvailable &&
              row.costAvailable &&
              base.cost !== undefined &&
              row.cost !== undefined,
        usageQuality: mergeUsageQuality(base.usageQuality, row.usageQuality),
        respondingRequests: base.respondingRequests + row.respondingRequests,
    }
}

/**
 * Add one performance row onto a totals accumulator.
 *
 * Means are recomputed from the summed values and their own coverage count, so two
 * buckets combine as a weighted mean. TTFT uses `ttftCoverage`, not `durationCoverage`:
 * a provider that reports a duration without TTFT must leave the average unknown
 * rather than report `0 ms`.
 */
export function accumulatePerformanceTotals(base: PerformanceTotals, row: PerformanceRow): PerformanceTotals {
    const durationCoverage = base.durationCoverage + row.durationCoverage
    const executionDurationCoverage = base.executionDurationCoverage + row.executionDurationCoverage
    const ttftCoverage = base.ttftCoverage + row.ttftCoverage
    const providerDurationMs = base.providerDurationMs + row.providerDurationMs
    const executionDurationMs = base.executionDurationMs + row.executionDurationMs
    const ttftMs = base.ttftMs + row.ttftMs
    return {
        providerDurationMs,
        executionDurationMs,
        generationDurationMs: base.generationDurationMs + row.generationDurationMs,
        ttftMs,
        requestCount: base.requestCount + row.requestCount,
        completedCount: base.completedCount + row.completedCount,
        failedCount: base.failedCount + row.failedCount,
        cancelledCount: base.cancelledCount + row.cancelledCount,
        abortedCount: base.abortedCount + row.abortedCount,
        providerRoundCount: base.providerRoundCount + row.providerRoundCount,
        executionCount: base.executionCount + row.executionCount,
        perfQuality: mergePerformanceQuality(base.perfQuality, row.perfQuality),
        durationCoverage,
        executionDurationCoverage,
        ttftCoverage,
        avgProviderDurationMs: meanOf(providerDurationMs, durationCoverage),
        avgExecutionDurationMs: meanOf(executionDurationMs, executionDurationCoverage),
        avgTtftMs: meanOf(ttftMs, ttftCoverage),
    }
}

/** A mean only exists when something contributed to its divisor. */
function meanOf(total: number, coverage: number): number | undefined {
    return coverage > 0 ? total / coverage : undefined
}

/**
 * Add one usage row's body onto another.
 *
 * A rollup folds finished buckets into a coarser one, so the arithmetic must be the
 * same addition the event path uses: the cache ratio stays a numerator/denominator
 * pair, and cost completeness survives only when every contributor was complete and
 * no currency conflict appeared.
 */
export function mergeUsageBodies(base: UsageBody, next: UsageBody): UsageBody {
    const mixed = base.currencyMixed || next.currencyMixed
    const currencyConflict =
        !mixed && base.currency !== undefined && next.currency !== undefined && base.currency !== next.currency
    if (mixed || currencyConflict) {
        return {
            inputTokens: base.inputTokens + next.inputTokens,
            outputTokens: base.outputTokens + next.outputTokens,
            thoughtsTokens: base.thoughtsTokens + next.thoughtsTokens,
            cacheWriteTokens: base.cacheWriteTokens + next.cacheWriteTokens,
            cacheReadTokens: base.cacheReadTokens + next.cacheReadTokens,
            cacheNumerator: base.cacheNumerator + next.cacheNumerator,
            cacheDenominator: base.cacheDenominator + next.cacheDenominator,
            usageAvailable: base.usageAvailable || next.usageAvailable,
            cacheUsageAvailable: base.cacheUsageAvailable || next.cacheUsageAvailable,
            cost: undefined,
            currency: undefined,
            currencyMixed: true,
            costAvailable: false,
            usageQuality: mergeUsageQuality(base.usageQuality, next.usageQuality),
            respondingRequests: base.respondingRequests + next.respondingRequests,
        }
    }
    const bothComplete = base.costAvailable && next.costAvailable && base.cost !== undefined && next.cost !== undefined
    const cost = base.cost !== undefined && next.cost !== undefined ? base.cost + next.cost : (base.cost ?? next.cost)
    return {
        inputTokens: base.inputTokens + next.inputTokens,
        outputTokens: base.outputTokens + next.outputTokens,
        thoughtsTokens: base.thoughtsTokens + next.thoughtsTokens,
        cacheWriteTokens: base.cacheWriteTokens + next.cacheWriteTokens,
        cacheReadTokens: base.cacheReadTokens + next.cacheReadTokens,
        cacheNumerator: base.cacheNumerator + next.cacheNumerator,
        cacheDenominator: base.cacheDenominator + next.cacheDenominator,
        usageAvailable: base.usageAvailable || next.usageAvailable,
        cacheUsageAvailable: base.cacheUsageAvailable || next.cacheUsageAvailable,
        cost,
        currency: base.currency ?? next.currency,
        currencyMixed: false,
        costAvailable: bothComplete,
        usageQuality: mergeUsageQuality(base.usageQuality, next.usageQuality),
        respondingRequests: base.respondingRequests + next.respondingRequests,
    }
}

/** Add one performance row's body onto another; counters and duration coverage add. */
export function mergePerformanceBodies(base: PerformanceBody, next: PerformanceBody): PerformanceBody {
    return {
        providerDurationMs: base.providerDurationMs + next.providerDurationMs,
        executionDurationMs: base.executionDurationMs + next.executionDurationMs,
        generationDurationMs: base.generationDurationMs + next.generationDurationMs,
        ttftMs: base.ttftMs + next.ttftMs,
        requestCount: base.requestCount + next.requestCount,
        completedCount: base.completedCount + next.completedCount,
        failedCount: base.failedCount + next.failedCount,
        cancelledCount: base.cancelledCount + next.cancelledCount,
        abortedCount: base.abortedCount + next.abortedCount,
        providerRoundCount: base.providerRoundCount + next.providerRoundCount,
        executionCount: base.executionCount + next.executionCount,
        perfQuality: mergePerformanceQuality(base.perfQuality, next.perfQuality),
        durationCoverage: base.durationCoverage + next.durationCoverage,
        executionDurationCoverage: base.executionDurationCoverage + next.executionDurationCoverage,
        ttftCoverage: base.ttftCoverage + next.ttftCoverage,
    }
}

/** The fact kinds a performance row may carry; one row never mixes them. */
export const PERFORMANCE_FACT_KINDS: readonly PerformanceFactKind[] = Object.freeze(["provider", "execution"])
