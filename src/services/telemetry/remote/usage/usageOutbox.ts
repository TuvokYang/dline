import { createHash } from "node:crypto"
import type { DeliveryOutcome } from "../contracts/classification"
import {
    afterAcknowledged,
    afterRateLimited,
    type ChannelPacing,
    INITIAL_PACING,
    isWaiting,
    mayStartBatch,
    replayBudgetExhausted,
    replayDelayMs,
    reserveInterval,
} from "../contracts/pacing"
import {
    USAGE_BODY_LIMIT_BYTES,
    USAGE_MAX_ACTIVE_MINUTES,
    USAGE_MINUTE_MS,
    type UsageBodyWire,
    type UsageClientWire,
    validateUsageBody,
} from "../contracts/usageBody"
import { buildUsageBody, mergeMinutes, minuteStartOf, selectBatchMinutes, type UsageMinute } from "./usageBatch"
import type { UsageTally } from "./usageTally"

/** One settled request or activation as it waits in a process shard. */
export interface PendingUsageObservation {
    readonly id: string
    /** Local receipt time, epoch milliseconds; the sender assigns the UTC minute. */
    readonly receivedAt: number
    /** Policy epoch the observation was admitted under; any other epoch is dropped unsent. */
    readonly policyEpoch: number
    readonly tally: UsageTally
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
    /** The minutes inside the body, counted as lost when the batch is abandoned. */
    readonly minutes: readonly UsageMinute[]
    /** Minutes lost before this body and reported by it. */
    readonly droppedMinutes: number
    /** Start of the replay window, moved later by every 429 wait so a wait never ages the batch. */
    readonly createdAt: number
    /** Replays after a timeout or a retryable failure; a 429 is not one. */
    readonly attempts: number
    readonly notBefore: number
}

/** Machine-wide usage delivery state; one sender at a time changes it under a fenced lease. */
export interface UsageOutboxState {
    /** Policy epoch every pending minute was gathered under. */
    readonly policyEpoch: number
    /** Server gate and 429 wait of the usage channel; they survive a restart and a consent change. */
    readonly pacing: ChannelPacing
    /** End of the newest minute already placed in a body; later arrivals for older minutes move here. */
    readonly sealedThrough: number
    /** Minutes lost before reaching a body, reported with the next one. */
    readonly droppedMinutes: number
    readonly minutes: readonly UsageMinute[]
    /** Sealed shards already folded, so a crash before their removal does not count them twice. */
    readonly foldedShards: readonly string[]
    readonly inflight?: UsageInflight
}

export function emptyUsageOutbox(
    policyEpoch: number,
    carried: Pick<Partial<UsageOutboxState>, "pacing" | "foldedShards"> = {},
): UsageOutboxState {
    return {
        policyEpoch,
        pacing: carried.pacing ?? INITIAL_PACING,
        sealedThrough: 0,
        droppedMinutes: 0,
        minutes: [],
        foldedShards: carried.foldedShards ?? [],
    }
}

/**
 * Bind the outbox to the current policy epoch. Data gathered under another
 * epoch spans a consent change and is dropped unsent; the server gate and any
 * wait are per device and survive.
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
 * later than the current one. At most 60 active minutes wait; the oldest beyond
 * that are dropped and counted.
 */
export function foldUsageShards(state: UsageOutboxState, shards: readonly SettledUsageShard[], now: number): UsageOutboxState {
    const folded = new Set(state.foldedShards)
    const currentMinute = minuteStartOf(now)
    const arrivals: UsageMinute[] = []
    for (const shard of shards) {
        if (folded.has(shard.name)) continue
        for (const observation of shard.observations) {
            if (observation.policyEpoch !== state.policyEpoch) continue
            const startedAt = Math.max(Math.min(minuteStartOf(observation.receivedAt), currentMinute), state.sealedThrough)
            arrivals.push({ startedAt, tally: observation.tally })
        }
    }
    const capped = capPendingMinutes(mergeMinutes(state.minutes, arrivals))
    return {
        ...state,
        minutes: capped.minutes,
        droppedMinutes: state.droppedMinutes + capped.dropped,
        foldedShards: shards.map((shard) => shard.name),
    }
}

export type UsageBatchDecision =
    | { readonly kind: "none" }
    | {
          readonly kind: "batch"
          readonly state: UsageOutboxState
          readonly inflight: UsageInflight
          readonly body: UsageBodyWire
          readonly bytes: Uint8Array
      }
    /** The batch broke a service rule; it is dropped and counted rather than sent and lost to a 422. */
    | { readonly kind: "rejected"; readonly state: UsageOutboxState; readonly violations: readonly string[] }

export interface UsageBatchInput {
    readonly now: number
    readonly requestId: string
    readonly client: UsageClientWire
    /** How long after a minute ends its observations may still be arriving from other shards. */
    readonly settleMs: number
}

/**
 * Take the oldest complete minutes, up to a 60-minute span, into a new batch
 * once the gate opened and no wait is running.
 *
 * The gate moves a default interval ahead as soon as the batch exists, so a
 * batch that is dropped without an acknowledgement still leaves the cadence in
 * place; the acknowledgement then sets the gate the service named.
 */
export function takeUsageBatch(state: UsageOutboxState, input: UsageBatchInput): UsageBatchDecision {
    const { now } = input
    if (state.inflight || !mayStartBatch(state.pacing, now)) return { kind: "none" }
    const complete = state.minutes.filter((minute) => minute.startedAt + USAGE_MINUTE_MS + input.settleMs <= now)
    const selected = selectBatchMinutes(complete)
    if (selected.length === 0) return { kind: "none" }
    const taken = new Set(selected.map((minute) => minute.startedAt))
    const remaining = state.minutes.filter((minute) => !taken.has(minute.startedAt))
    const sealedThrough = Math.max(state.sealedThrough, (selected.at(-1) as UsageMinute).startedAt + USAGE_MINUTE_MS)
    const body = buildUsageBody(selected, input.client, state.droppedMinutes)
    // Minutes without any activity hold nothing to report, so they leave without being counted as lost.
    if (!body) return { kind: "rejected", violations: ["no_activity"], state: { ...state, minutes: remaining, sealedThrough } }
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    const violations: string[] = validateUsageBody(body)
    if (bytes.byteLength > USAGE_BODY_LIMIT_BYTES) violations.push("body_size")
    if (violations.length > 0) {
        return {
            kind: "rejected",
            violations,
            state: { ...state, minutes: remaining, sealedThrough, droppedMinutes: state.droppedMinutes + selected.length },
        }
    }
    const inflight: UsageInflight = {
        requestId: input.requestId,
        bodySha256: sha256Hex(bytes),
        minutes: selected,
        droppedMinutes: state.droppedMinutes,
        createdAt: now,
        attempts: 0,
        notBefore: now,
    }
    return {
        kind: "batch",
        inflight,
        body,
        bytes,
        state: {
            ...state,
            minutes: remaining,
            sealedThrough,
            droppedMinutes: 0,
            inflight,
            pacing: reserveInterval(state.pacing, "usage", now),
        },
    }
}

/** The inflight, when it is due for another attempt and no wait holds the channel. */
export function dueUsageReplay(state: UsageOutboxState, now: number): UsageInflight | undefined {
    const inflight = state.inflight
    if (!inflight || now < inflight.notBefore || isWaiting(state.pacing, now)) return undefined
    return inflight
}

export type UsageInflightResolution =
    | Extract<DeliveryOutcome, { kind: "acknowledged" | "replay" | "wait" | "too_large" | "discard" }>
    /** The exact bytes are gone or corrupt; re-serialising could count twice, so the batch is dropped. */
    | { readonly kind: "body_lost" }

/** Apply what the service said about the inflight. A different request ID means another sender moved on. */
export function settleUsageInflight(
    state: UsageOutboxState,
    requestId: string,
    resolution: UsageInflightResolution,
    now: number,
    random: () => number = Math.random,
): UsageOutboxState {
    const inflight = state.inflight
    if (!inflight || inflight.requestId !== requestId) return state
    const { inflight: _settled, ...rest } = state
    switch (resolution.kind) {
        case "acknowledged":
            return { ...rest, pacing: afterAcknowledged(state.pacing, "usage", resolution.nextEligibleAt, now) }
        case "wait": {
            // An earlier timed-out attempt may already be stored, so the batch keeps its request ID and bytes and
            // is replayed first once the wait ends. The wait is the service's, not a failed attempt: it neither
            // consumes a replay nor ages the batch towards its discard limit.
            const pacing = afterRateLimited(state.pacing, resolution.retryAfterMs, now, random)
            const waited = Math.max(0, pacing.waitUntil - now)
            return {
                ...state,
                inflight: { ...inflight, createdAt: inflight.createdAt + waited, notBefore: pacing.waitUntil },
                pacing,
            }
        }
        case "replay": {
            const attempts = inflight.attempts + 1
            if (replayBudgetExhausted(attempts, inflight.createdAt, now)) return abandon(rest, inflight)
            const notBefore = now + replayDelayMs(attempts, resolution.retryAfterMs)
            return { ...state, inflight: { ...inflight, attempts, notBefore } }
        }
        case "too_large":
        case "discard":
        case "body_lost":
            return abandon(rest, inflight)
    }
}

function abandon(state: Omit<UsageOutboxState, "inflight">, inflight: UsageInflight): UsageOutboxState {
    return { ...state, droppedMinutes: state.droppedMinutes + inflight.droppedMinutes + inflight.minutes.length }
}

/** Keep the newest 60 pending minutes in order; older ones are dropped and counted. */
function capPendingMinutes(minutes: readonly UsageMinute[]): { minutes: UsageMinute[]; dropped: number } {
    const sorted = [...minutes].sort((left, right) => left.startedAt - right.startedAt)
    const kept = sorted.slice(-USAGE_MAX_ACTIVE_MINUTES)
    return { minutes: kept, dropped: sorted.length - kept.length }
}

export function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex")
}
