import { createHash } from "node:crypto"
import type { UsageOutcome } from "../contracts/classification"
import {
    USAGE_BODY_LIMIT_BYTES,
    USAGE_MAX_AGGREGATED_WINDOWS,
    USAGE_WINDOW_MS,
    type UsageAggregateViolation,
    type UsageAggregateWire,
    type UsageAttributeKey,
    validateUsageAggregate,
} from "../contracts/wire"
import type { UsageObservation } from "./usageCatalog"
import { buildUsageAggregate, mergeObservations, type UsageWindow, windowStartOf } from "./usageWindow"

/** Extra wait past the server gate, so a small disagreement between clocks does not cost a 429. */
export const USAGE_GATE_MARGIN_MS = 2_000
/** Pending minutes kept locally: one full batch plus the minute still filling. */
export const MAX_PENDING_USAGE_WINDOWS = USAGE_MAX_AGGREGATED_WINDOWS + 1
/** An inflight whose outcome stays unknown this often, or this long, is abandoned instead of retried forever. */
export const MAX_USAGE_REPLAY_ATTEMPTS = 12
export const MAX_USAGE_INFLIGHT_AGE_MS = 24 * 60 * 60_000
const REPLAY_BACKOFF_BASE_MS = 30_000
const REPLAY_BACKOFF_CAP_MS = 30 * 60_000

/** One settled request as it waits in a process shard, already projected onto the remote catalog. */
export interface PendingUsageObservation extends UsageObservation {
    readonly id: string
    /** Local receipt time, epoch milliseconds; the sender assigns the UTC minute. */
    readonly receivedAt: number
    /** Policy epoch the observation was admitted under; any other epoch is dropped unsent. */
    readonly policyEpoch: number
}

/** A sealed shard that settled, as read by the sender. */
export interface SettledUsageShard {
    readonly name: string
    readonly observations: readonly PendingUsageObservation[]
}

/** The batch the server may already hold. Its exact bytes live beside the outbox under `requestId`. */
export interface UsageInflight {
    readonly requestId: string
    readonly bodySha256: string
    /** The minutes inside the body, merged back into pending when the server certainly stored nothing. */
    readonly windows: readonly UsageWindow[]
    /** Windows lost before this body and reported by it. */
    readonly droppedWindows: number
    readonly createdAt: number
    readonly attempts: number
    readonly notBefore: number
}

/** Machine-wide usage delivery state; one sender at a time changes it under a fenced lease. */
export interface UsageOutboxState {
    /** Policy epoch every pending window was gathered under. */
    readonly policyEpoch: number
    /** Local time before which no new batch may be sent; replays of the inflight are not gated. */
    readonly nextEligibleAt: number
    /** End of the newest minute already placed in a body; later arrivals for older minutes move here. */
    readonly sealedThrough: number
    /** Windows lost before reaching a body, reported with the next one. */
    readonly droppedWindows: number
    readonly windows: readonly UsageWindow[]
    /** Sealed shards already folded, so a crash before their removal does not count them twice. */
    readonly foldedShards: readonly string[]
    readonly inflight?: UsageInflight
}

export function emptyUsageOutbox(
    policyEpoch: number,
    carried: Pick<Partial<UsageOutboxState>, "nextEligibleAt" | "foldedShards"> = {},
): UsageOutboxState {
    return {
        policyEpoch,
        nextEligibleAt: carried.nextEligibleAt ?? 0,
        sealedThrough: 0,
        droppedWindows: 0,
        windows: [],
        foldedShards: carried.foldedShards ?? [],
    }
}

/**
 * Bind the outbox to the current policy epoch. Data gathered under another
 * epoch spans a consent change and is dropped unsent; the server gate is
 * per device and survives.
 */
export function alignUsagePolicyEpoch(state: UsageOutboxState, policyEpoch: number): UsageOutboxState {
    if (state.policyEpoch === policyEpoch) return state
    return emptyUsageOutbox(policyEpoch, state)
}

/**
 * Fold settled shards into pending minutes.
 *
 * `shards` must list every settled shard still on disk: a name folded earlier
 * and absent now was removed, so it is forgotten. An observation lands in the
 * minute it was received, never earlier than a minute already sent and never
 * later than the current one.
 */
export function foldUsageShards(state: UsageOutboxState, shards: readonly SettledUsageShard[], now: number): UsageOutboxState {
    const folded = new Set(state.foldedShards)
    const byMinute = new Map(state.windows.map((window) => [window.startedAt, window]))
    const currentMinute = windowStartOf(now)
    for (const shard of shards) {
        if (folded.has(shard.name)) continue
        for (const observation of shard.observations) {
            if (observation.policyEpoch !== state.policyEpoch) continue
            const minute = Math.max(Math.min(windowStartOf(observation.receivedAt), currentMinute), state.sealedThrough)
            const existing = byMinute.get(minute)
            const merged = existing ? mergeObservations(existing, observation) : observation
            byMinute.set(minute, { startedAt: minute, counters: merged.counters, measurements: merged.measurements })
        }
    }
    const capped = capPendingWindows([...byMinute.values()])
    return {
        ...state,
        windows: capped.windows,
        droppedWindows: state.droppedWindows + capped.dropped,
        foldedShards: shards.map((shard) => shard.name),
    }
}

export type UsageBatchDecision =
    | { readonly kind: "none" }
    | {
          readonly kind: "batch"
          readonly state: UsageOutboxState
          readonly inflight: UsageInflight
          readonly aggregate: UsageAggregateWire
          readonly body: Uint8Array
      }
    /** The batch broke a server rule; it is dropped and counted rather than sent and lost as a 4xx. */
    | { readonly kind: "rejected"; readonly state: UsageOutboxState; readonly violations: readonly string[] }

export interface UsageBatchInput {
    readonly now: number
    readonly requestId: string
    readonly attributes: Readonly<Partial<Record<UsageAttributeKey, string | boolean>>>
    /** How long after a minute ends its observations may still be arriving from other shards. */
    readonly settleMs: number
}

/**
 * Take every complete minute into a new batch once the machine gate opened.
 *
 * The gate moves a full interval ahead as soon as the batch exists: if this
 * process dies after sending, the next sender loses a slot instead of sending
 * a second new batch inside the server's window.
 */
export function takeUsageBatch(state: UsageOutboxState, input: UsageBatchInput): UsageBatchDecision {
    const { now } = input
    if (state.inflight || now < state.nextEligibleAt) return { kind: "none" }
    const complete = state.windows.filter((window) => window.startedAt + USAGE_WINDOW_MS + input.settleMs <= now)
    const aggregate = buildUsageAggregate(complete, input.attributes, state.droppedWindows)
    if (!aggregate) return { kind: "none" }
    const kept = complete.filter((window) => window.startedAt >= aggregate.window_started_at)
    const pending = state.windows.filter((window) => !complete.includes(window))
    const sealedThrough = Math.max(state.sealedThrough, aggregate.window_ended_at)
    const reportedDrops = aggregate.dropped_windows ?? 0
    const body = new TextEncoder().encode(JSON.stringify(aggregate))
    const violations: (UsageAggregateViolation | "body_size")[] = validateUsageAggregate(aggregate, now)
    if (body.byteLength > USAGE_BODY_LIMIT_BYTES) violations.push("body_size")
    if (violations.length > 0) {
        return {
            kind: "rejected",
            violations,
            state: { ...state, windows: pending, sealedThrough, droppedWindows: reportedDrops + kept.length },
        }
    }
    const inflight: UsageInflight = {
        requestId: input.requestId,
        bodySha256: sha256Hex(body),
        windows: kept,
        droppedWindows: reportedDrops,
        createdAt: now,
        attempts: 0,
        notBefore: now,
    }
    return {
        kind: "batch",
        inflight,
        aggregate,
        body,
        state: {
            ...state,
            windows: pending,
            sealedThrough,
            droppedWindows: 0,
            inflight,
            nextEligibleAt: Math.max(state.nextEligibleAt, now + USAGE_WINDOW_MS + USAGE_GATE_MARGIN_MS),
        },
    }
}

/** The inflight, when it is due for another attempt. */
export function dueUsageReplay(state: UsageOutboxState, now: number): UsageInflight | undefined {
    return state.inflight && now >= state.inflight.notBefore ? state.inflight : undefined
}

export type UsageInflightResolution =
    | Extract<UsageOutcome, { kind: "acknowledged" | "replay" | "defer" | "discard" }>
    /** The exact bytes are gone or corrupt; re-serialising could count twice, so the batch is dropped. */
    | { readonly kind: "body_lost" }

/** Apply what the server said about the inflight. A different request ID means another sender moved on. */
export function settleUsageInflight(
    state: UsageOutboxState,
    requestId: string,
    resolution: UsageInflightResolution,
    now: number,
): UsageOutboxState {
    const inflight = state.inflight
    if (!inflight || inflight.requestId !== requestId) return state
    const { inflight: _settled, ...rest } = state
    switch (resolution.kind) {
        case "acknowledged":
            return { ...rest, nextEligibleAt: Math.max(state.nextEligibleAt, now + USAGE_WINDOW_MS + USAGE_GATE_MARGIN_MS) }
        case "defer": {
            const capped = capPendingWindows(mergeWindowLists(rest.windows, inflight.windows))
            const delay = resolution.retryAfterMs ?? USAGE_WINDOW_MS
            return {
                ...rest,
                windows: capped.windows,
                droppedWindows: state.droppedWindows + inflight.droppedWindows + capped.dropped,
                nextEligibleAt: Math.max(state.nextEligibleAt, now + delay + USAGE_GATE_MARGIN_MS),
            }
        }
        case "replay": {
            const attempts = inflight.attempts + 1
            if (attempts >= MAX_USAGE_REPLAY_ATTEMPTS || now - inflight.createdAt >= MAX_USAGE_INFLIGHT_AGE_MS) {
                return abandon(rest, inflight)
            }
            const delay = Math.max(resolution.retryAfterMs ?? 0, replayBackoffMs(attempts))
            return { ...state, inflight: { ...inflight, attempts, notBefore: now + delay } }
        }
        case "discard":
        case "body_lost":
            return abandon(rest, inflight)
    }
}

function abandon(state: Omit<UsageOutboxState, "inflight">, inflight: UsageInflight): UsageOutboxState {
    return { ...state, droppedWindows: state.droppedWindows + inflight.droppedWindows + inflight.windows.length }
}

function replayBackoffMs(attempts: number): number {
    return Math.min(REPLAY_BACKOFF_CAP_MS, REPLAY_BACKOFF_BASE_MS * 2 ** (attempts - 1))
}

function mergeWindowLists(left: readonly UsageWindow[], right: readonly UsageWindow[]): UsageWindow[] {
    const byMinute = new Map(left.map((window) => [window.startedAt, window]))
    for (const window of right) {
        const existing = byMinute.get(window.startedAt)
        const merged = existing ? mergeObservations(existing, window) : window
        byMinute.set(window.startedAt, {
            startedAt: window.startedAt,
            counters: merged.counters,
            measurements: merged.measurements,
        })
    }
    return [...byMinute.values()]
}

/** Keep the newest pending minutes in order; older ones are dropped and counted. */
function capPendingWindows(windows: readonly UsageWindow[]): { windows: UsageWindow[]; dropped: number } {
    const sorted = [...windows].sort((left, right) => left.startedAt - right.startedAt)
    const kept = sorted.slice(-MAX_PENDING_USAGE_WINDOWS)
    return { windows: kept, dropped: sorted.length - kept.length }
}

export function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex")
}
