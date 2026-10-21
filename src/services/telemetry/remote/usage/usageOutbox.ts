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
    USAGE_MAX_ACTIVE_SECONDS,
    USAGE_SECOND_MS,
    type UsageBodyWire,
    type UsageClientWire,
    validateUsageBody,
} from "../contracts/usageBody"
import { buildUsageBody, mergeSeconds, secondStartOf, selectBatchSeconds, type UsageSecond } from "./usageBatch"
import type { UsageTally } from "./usageTally"

/** One settled request or activation as it waits in a process shard. */
export interface PendingUsageObservation {
    readonly id: string
    /** Local receipt time, epoch milliseconds; the sender assigns the UTC second. */
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
    /** The seconds inside the body, counted as lost when the batch is abandoned. */
    readonly seconds: readonly UsageSecond[]
    /** Active seconds lost before this body and reported by it. */
    readonly droppedSeconds: number
    /** Start of the replay window, moved later by every 429 wait so a wait never ages the batch. */
    readonly createdAt: number
    /** Replays after a timeout or a retryable failure; a 429 is not one. */
    readonly attempts: number
    readonly notBefore: number
}

/** Machine-wide usage delivery state; one sender at a time changes it under a fenced lease. */
export interface UsageOutboxState {
    /** Policy epoch every pending second was gathered under. */
    readonly policyEpoch: number
    /** Server gate and 429 wait of the usage channel; they survive a restart and a consent change. */
    readonly pacing: ChannelPacing
    /** End of the newest second already placed in a body; later arrivals for older seconds move here. */
    readonly sealedThrough: number
    /** Active seconds lost before reaching a body, reported with the next one. */
    readonly droppedSeconds: number
    readonly seconds: readonly UsageSecond[]
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
        droppedSeconds: 0,
        seconds: [],
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
 * Fold settled shards into pending seconds.
 *
 * `shards` must list every settled shard still on disk: a name folded earlier
 * and absent now was removed, so it is forgotten. An observation lands in the
 * second it was received, never earlier than a second already sent and never
 * later than the current one. At most 3600 pending seconds wait, one hour of
 * contiguous activity inside the contract's window; the oldest beyond that are
 * dropped and counted.
 */
export function foldUsageShards(state: UsageOutboxState, shards: readonly SettledUsageShard[], now: number): UsageOutboxState {
    const folded = new Set(state.foldedShards)
    const currentSecond = secondStartOf(now)
    const arrivals: UsageSecond[] = []
    for (const shard of shards) {
        if (folded.has(shard.name)) continue
        for (const observation of shard.observations) {
            if (observation.policyEpoch !== state.policyEpoch) continue
            const startedAt = Math.max(Math.min(secondStartOf(observation.receivedAt), currentSecond), state.sealedThrough)
            arrivals.push({ startedAt, tally: observation.tally })
        }
    }
    const capped = capPendingSeconds(mergeSeconds(state.seconds, arrivals))
    return {
        ...state,
        seconds: capped.seconds,
        droppedSeconds: state.droppedSeconds + capped.dropped,
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
    /** How long after a second ends its observations may still be arriving from other shards. */
    readonly settleMs: number
}

/**
 * Take the oldest complete seconds, up to a 60-minute span, into a new batch
 * once the gate opened and no wait is running.
 *
 * The gate moves a default interval ahead as soon as the batch exists, so a
 * batch that is dropped without an acknowledgement still leaves the cadence in
 * place; the acknowledgement then sets the gate the service named.
 */
export function takeUsageBatch(state: UsageOutboxState, input: UsageBatchInput): UsageBatchDecision {
    const { now } = input
    if (state.inflight || !mayStartBatch(state.pacing, now)) return { kind: "none" }
    const complete = state.seconds.filter((second) => second.startedAt + USAGE_SECOND_MS + input.settleMs <= now)
    const selected = selectBatchSeconds(complete)
    if (selected.length === 0) return { kind: "none" }
    const taken = new Set(selected.map((second) => second.startedAt))
    const remaining = state.seconds.filter((second) => !taken.has(second.startedAt))
    const sealedThrough = Math.max(state.sealedThrough, (selected.at(-1) as UsageSecond).startedAt + USAGE_SECOND_MS)
    const body = buildUsageBody(selected, input.client, state.droppedSeconds)
    // Seconds without any activity hold nothing to report, so they leave without being counted as lost.
    if (!body) {
        return { kind: "rejected", violations: ["no_activity"], state: { ...state, seconds: remaining, sealedThrough } }
    }
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    const violations: string[] = validateUsageBody(body)
    if (bytes.byteLength > USAGE_BODY_LIMIT_BYTES) violations.push("body_size")
    if (violations.length > 0) {
        return {
            kind: "rejected",
            violations,
            state: { ...state, seconds: remaining, sealedThrough, droppedSeconds: state.droppedSeconds + selected.length },
        }
    }
    const inflight: UsageInflight = {
        requestId: input.requestId,
        bodySha256: sha256Hex(bytes),
        seconds: selected,
        droppedSeconds: state.droppedSeconds,
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
            seconds: remaining,
            sealedThrough,
            droppedSeconds: 0,
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
    return { ...state, droppedSeconds: state.droppedSeconds + inflight.droppedSeconds + inflight.seconds.length }
}

/** Keep the newest 3600 pending seconds in order; older ones are dropped and counted. */
function capPendingSeconds(seconds: readonly UsageSecond[]): { seconds: UsageSecond[]; dropped: number } {
    const sorted = [...seconds].sort((left, right) => left.startedAt - right.startedAt)
    const kept = sorted.slice(-USAGE_MAX_ACTIVE_SECONDS)
    return { seconds: kept, dropped: sorted.length - kept.length }
}

export function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex")
}
