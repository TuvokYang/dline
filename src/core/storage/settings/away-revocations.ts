import type { AwayRevocations } from "@shared/away"
import type { Settings } from "@shared/storage/state-keys"

export const AWAY_REVOCATIONS_KEY = "__awayRevocations" as const
export const INITIAL_AWAY_REVOCATIONS: AwayRevocations = Object.freeze({ mode: 0, automatic: 0 })

export function parseAwayRevocations(value: unknown): AwayRevocations {
    if (value === undefined) return INITIAL_AWAY_REVOCATIONS
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Away revocation metadata")
    const { mode, automatic } = value as Record<string, unknown>
    if (!Number.isSafeInteger(mode) || Number(mode) < 0 || !Number.isSafeInteger(automatic) || Number(automatic) < 0) {
        throw new Error("Invalid Away revocation metadata")
    }
    return Object.freeze({ mode: Number(mode), automatic: Number(automatic) })
}

function increment(value: number): number {
    const next = value + 1
    if (!Number.isSafeInteger(next)) throw new Error("Away revocation generation exhausted")
    return next
}

/** All canonical writes, including deletion and non-UI writers, enforce the same revocation rule. */
export function updateAwayRevocations(
    previous: Settings,
    next: Settings,
    current: AwayRevocations,
    revokeMode: boolean,
): AwayRevocations {
    const modeClosed = revokeMode || (previous.awayModeEnabled === true && next.awayModeEnabled !== true)
    const automaticClosed = modeClosed || (previous.autoAwayModeEnabled === true && next.autoAwayModeEnabled !== true)
    return Object.freeze({
        mode: modeClosed ? increment(current.mode) : current.mode,
        automatic: automaticClosed ? increment(current.automatic) : current.automatic,
    })
}
