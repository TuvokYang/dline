import {
    USAGE_MAX_AGGREGATED_WINDOWS,
    USAGE_SCHEMA_VERSION,
    USAGE_WINDOW_MS,
    type UsageAggregateWire,
    type UsageAttributeKey,
    type UsageMeasurementWire,
} from "../contracts/wire"
import type { UsageObservation } from "./usageCatalog"

/** One sealed UTC minute of usage, merged across every process shard. */
export interface UsageWindow extends UsageObservation {
    /** Start of the UTC minute, epoch milliseconds. */
    readonly startedAt: number
}

export function windowStartOf(epochMs: number): number {
    return Math.floor(epochMs / USAGE_WINDOW_MS) * USAGE_WINDOW_MS
}

/**
 * Merge two observations of the same window.
 *
 * Counters add and saturate at the largest safe integer instead of losing
 * precision; summaries merge mathematically so `min*count <= sum <= max*count`
 * still holds for the server's check.
 */
export function mergeObservations(left: UsageObservation, right: UsageObservation): UsageObservation {
    const counters: Record<string, number> = { ...left.counters }
    for (const [name, value] of Object.entries(right.counters)) {
        counters[name] = Math.min(Number.MAX_SAFE_INTEGER, (counters[name] ?? 0) + value)
    }
    const measurements: Record<string, UsageMeasurementWire> = { ...left.measurements }
    for (const [name, value] of Object.entries(right.measurements)) {
        const previous = measurements[name]
        measurements[name] = previous
            ? {
                  count: previous.count + value.count,
                  sum: previous.sum + value.sum,
                  min: Math.min(previous.min, value.min),
                  max: Math.max(previous.max, value.max),
              }
            : value
    }
    return { counters, measurements }
}

/**
 * Fold sealed windows into one `/v1/usage` body.
 *
 * At most ten distinct minutes travel together; older ones are dropped and
 * counted, and the start moves forward with them, because the server rejects a
 * span longer than the windows it claims to cover.
 */
export function buildUsageAggregate(
    windows: readonly UsageWindow[],
    attributes: Readonly<Partial<Record<UsageAttributeKey, string | boolean>>>,
    previouslyDropped = 0,
): UsageAggregateWire | undefined {
    const byMinute = new Map<number, UsageObservation>()
    for (const window of windows) {
        const start = windowStartOf(window.startedAt)
        const existing = byMinute.get(start)
        byMinute.set(start, existing ? mergeObservations(existing, window) : window)
    }
    const minutes = [...byMinute.keys()].sort((left, right) => left - right)
    if (minutes.length === 0) return undefined
    const kept = minutes.slice(-USAGE_MAX_AGGREGATED_WINDOWS)
    const dropped = previouslyDropped + (minutes.length - kept.length)
    let merged: UsageObservation = { counters: {}, measurements: {} }
    for (const minute of kept) merged = mergeObservations(merged, byMinute.get(minute) as UsageObservation)
    return {
        schema_version: USAGE_SCHEMA_VERSION,
        window_started_at: kept[0],
        window_ended_at: (kept.at(-1) as number) + USAGE_WINDOW_MS,
        aggregation_count: kept.length,
        ...(dropped > 0 ? { dropped_windows: dropped } : {}),
        counters: merged.counters,
        ...(Object.keys(merged.measurements).length > 0 ? { measurements: merged.measurements } : {}),
        ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    }
}
