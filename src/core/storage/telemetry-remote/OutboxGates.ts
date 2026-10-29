import type { ChannelPacing } from "@/services/telemetry/remote/contracts/pacing"

/**
 * The persisted gates every production telemetry outbox keeps beside its
 * records: the device admission count of the current UTC hour and day, and the
 * channel pacing (server gate, 429 wait). They are state about the channel, not
 * about the user, so clearing the records on withdrawn consent keeps them.
 */

const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS

export interface StoredQuota {
    readonly hour_start: number
    readonly hour_count: number
    readonly day_start: number
    readonly day_count: number
}

export interface StoredPacing {
    readonly next_eligible_at: number
    readonly wait_until: number
    readonly consecutive_waits: number
}

export const EMPTY_QUOTA: StoredQuota = { hour_start: 0, hour_count: 0, day_start: 0, day_count: 0 }
export const EMPTY_PACING: StoredPacing = { next_eligible_at: 0, wait_until: 0, consecutive_waits: 0 }

/** Start a new hour or day count once the UTC hour or day changed. */
export function rollQuota(quota: StoredQuota, now: number): StoredQuota {
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS
    return {
        hour_start: hourStart,
        hour_count: quota.hour_start === hourStart ? quota.hour_count : 0,
        day_start: dayStart,
        day_count: quota.day_start === dayStart ? quota.day_count : 0,
    }
}

/** Count one more admitted record in the current hour and day. */
export function countAdmitted(quota: StoredQuota): StoredQuota {
    return { ...quota, hour_count: quota.hour_count + 1, day_count: quota.day_count + 1 }
}

export function pacingOf(stored: StoredPacing): ChannelPacing {
    return { nextEligibleAt: stored.next_eligible_at, waitUntil: stored.wait_until, consecutiveWaits: stored.consecutive_waits }
}

export function storedPacing(pacing: ChannelPacing): StoredPacing {
    return { next_eligible_at: pacing.nextEligibleAt, wait_until: pacing.waitUntil, consecutive_waits: pacing.consecutiveWaits }
}

export function isStoredQuota(value: unknown): value is StoredQuota {
    return (
        isRecord(value) &&
        isCount(value.hour_start) &&
        isCount(value.hour_count) &&
        isCount(value.day_start) &&
        isCount(value.day_count)
    )
}

export function isStoredPacing(value: unknown): value is StoredPacing {
    return isRecord(value) && isCount(value.next_eligible_at) && isCount(value.wait_until) && isCount(value.consecutive_waits)
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
