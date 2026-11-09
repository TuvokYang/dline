/**
 * Time bucketing for accumulated rows.
 *
 * Buckets are derived from the event's own observation time, never from arrival
 * order, so late events land in the bucket they belong to and a batch retry cannot
 * move a number to a different row.
 */

import type { MetricsResolution } from "./types"

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

/** Width of each resolution in milliseconds. */
export const RESOLUTION_MS: Readonly<Record<MetricsResolution, number>> = Object.freeze({
    minute: MINUTE_MS,
    hour: HOUR_MS,
    day: DAY_MS,
})

/** Resolutions ordered from finest to coarsest, for coverage selection. */
export const RESOLUTIONS_BY_INCREASING_WIDTH: readonly MetricsResolution[] = Object.freeze(["minute", "hour", "day"])

/**
 * The start of the bucket containing `observedAtMs`.
 *
 * Flooring keeps a bucket's start stable regardless of when it is computed, which is
 * what lets a rolled-up row and a freshly written row agree on identity.
 */
export function bucketStartOf(observedAtMs: number, resolution: MetricsResolution = "minute"): number {
    const width = RESOLUTION_MS[resolution]
    return Math.floor(observedAtMs / width) * width
}

/**
 * Whether `bucketStartMs` is a finished bucket at `nowMs`.
 *
 * A physical rollup may only fold buckets that can no longer receive a legal late
 * event, so this guards against folding the bucket that is still filling.
 */
export function isClosedBucket(bucketStartMs: number, resolution: MetricsResolution, nowMs: number): boolean {
    return bucketStartMs + RESOLUTION_MS[resolution] <= nowMs
}

/**
 * The next coarser resolution, or `undefined` at the coarsest one.
 *
 * Rollup walks this chain so an hour row is always produced from minute rows, never
 * from another hour row.
 */
export function coarserResolution(resolution: MetricsResolution): MetricsResolution | undefined {
    switch (resolution) {
        case "minute":
            return "hour"
        case "hour":
            return "day"
        case "day":
            return undefined
    }
}
