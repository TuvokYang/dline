import { createHash } from "node:crypto"
import type {
    PendingUsageAttemptObservation,
    SettledUsageAttemptShard,
} from "@/core/storage/telemetry-remote/UsageObservationSpool"
import type { DeliveryOutcome } from "../contracts/classification"
import {
    afterAcknowledged,
    afterRateLimited,
    type ChannelPacing,
    INITIAL_PACING,
    isWaiting,
    MAX_REPLAY_AGE_MS,
    MAX_WAIT_MS,
    mayStartBatch,
    replayBudgetExhausted,
    replayDelayMs,
    reserveInterval,
} from "../contracts/pacing"
import {
    buildUsageAttemptBody,
    USAGE_BODY_LIMIT_BYTES,
    USAGE_MAX_ACTIVE_SECONDS,
    USAGE_SECOND_MS,
    type UsageAttemptBodyValidation,
    type UsageAttemptBodyWire,
    type UsageBodyWire,
    type UsageClientWire,
    validateUsageAttemptBody,
    validateUsageBody,
} from "../contracts/usageBody"
import {
    type AttemptBucket,
    type AttemptBucketState,
    appendAttemptToBucketsWithTarget,
    emptyAttemptBucketState,
    sealOpenAttemptBucket,
    sealOpenAttemptBucketIfDue,
} from "./attemptBucket"
import { buildUsageBody, mergeSeconds, secondStartOf, selectBatchSeconds, type UsageSecond } from "./usageBatch"
import { type UsageTally, UsageTallyReductionError } from "./usageTally"

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
    /** Lowest policy epoch still legal in this uninterrupted allowed period. */
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

export interface UsageAttemptInflight {
    readonly requestId: string
    readonly bodySha256: string
    readonly bucketIds: readonly string[]
    readonly createdAt: number
    readonly attempts: number
    readonly notBefore: number
}

/** Machine-wide schema 4 bucket state, changed only by the fenced repository lease holder. */
export interface UsageAttemptObservationCheckpoint {
    readonly revision: number
    /** Bucket that owns the reduced attempt; the checkpoint is released with that bucket. */
    readonly bucketId: string
}

export interface UsageAttemptOutboxState {
    /** Lowest policy generation still legal after the last destructive reset. */
    readonly policyGeneration: number
    readonly pacing: ChannelPacing
    readonly buckets: AttemptBucketState
    /** Shards included by the last committed fold; retained until those files disappear. */
    readonly foldedShards: readonly string[]
    /** Highest revision durably reduced for each finalized attempt ID while its bucket remains retained. */
    readonly observationRevisions: Readonly<Record<string, UsageAttemptObservationCheckpoint>>
    readonly inflight?: UsageAttemptInflight
}

/** A 7-day service wait plus the 24-hour unknown-outcome replay budget. */
export const USAGE_ATTEMPT_BACKLOG_MAX_AGE_MS = MAX_WAIT_MS + MAX_REPLAY_AGE_MS
/** A bounded FIFO prefix large enough for 512 maximum-size requests. */
export const USAGE_ATTEMPT_BACKLOG_MAX_BUCKETS = 4_096
/** Durable bucket plus checkpoint budget; exact request bodies remain separately capped at 64 KiB. */
export const USAGE_ATTEMPT_BACKLOG_MAX_BYTES = 64 * 1024 * 1024

export function emptyUsageAttemptOutbox(
    policyGeneration: number,
    carried: Pick<Partial<UsageAttemptOutboxState>, "pacing"> = {},
): UsageAttemptOutboxState {
    if (!Number.isSafeInteger(policyGeneration) || policyGeneration < 0) {
        throw new Error("Usage attempt policy generation must be a non-negative safe integer")
    }
    return {
        policyGeneration,
        pacing: carried.pacing ?? INITIAL_PACING,
        buckets: emptyAttemptBucketState(),
        foldedShards: [],
        observationRevisions: {},
    }
}

export interface UsageAttemptObservationRejection {
    readonly shardName: string
    readonly observation: PendingUsageAttemptObservation
    readonly violations: readonly string[]
}

export interface UsageAttemptFoldOptions {
    readonly currentPolicyGeneration: number
    readonly newBucketId: () => string
    readonly sealedAt: number
    readonly eventWindowMs?: number
    readonly onRejected?: (rejection: UsageAttemptObservationRejection) => void
}

/**
 * Deterministically fold settled process shards into durable open/sealed buckets.
 *
 * All candidates are sorted independently of process completion order. A shard
 * checkpoint and per-attempt revision are committed with the bucket mutation;
 * replaying the same settled files is therefore a no-op. A higher revision after
 * an attempt was already reduced is rejected rather than double-counted: the
 * finalization barrier must publish only its highest revision.
 */
export function foldUsageAttemptShards(
    state: UsageAttemptOutboxState,
    shards: readonly SettledUsageAttemptShard[],
    options: UsageAttemptFoldOptions,
): UsageAttemptOutboxState {
    if (!Number.isSafeInteger(options.currentPolicyGeneration) || options.currentPolicyGeneration < state.policyGeneration) {
        throw new Error("Usage attempt policy generation is invalid")
    }
    if (!Number.isSafeInteger(options.sealedAt) || options.sealedAt < 0) throw new Error("Usage attempt seal time is invalid")

    const alreadyFolded = new Set(state.foldedShards)
    const candidates: { shardName: string; observation: PendingUsageAttemptObservation }[] = []
    for (const shard of shards) {
        if (alreadyFolded.has(shard.name)) continue
        for (const observation of shard.observations) candidates.push({ shardName: shard.name, observation })
    }
    candidates.sort(compareAttemptCandidates)

    let buckets = state.buckets
    const revisions = { ...state.observationRevisions }
    for (const candidate of candidates) {
        const { observation: pending } = candidate
        const observation = pending.observation
        if (
            observation.policyGeneration < state.policyGeneration ||
            observation.policyGeneration > options.currentPolicyGeneration
        ) {
            continue
        }
        const reduced = revisions[pending.id]
        if (reduced !== undefined) {
            if (pending.revision > reduced.revision) {
                options.onRejected?.({
                    ...candidate,
                    violations: ["revision_after_checkpoint"],
                })
            }
            continue
        }
        try {
            const appended = appendAttemptToBucketsWithTarget(buckets, observation, {
                newBucketId: options.newBucketId,
                sealedAt: () => options.sealedAt,
                eventWindowMs: options.eventWindowMs,
            })
            buckets = appended.state
            revisions[pending.id] = { revision: pending.revision, bucketId: appended.bucketId }
        } catch (error) {
            options.onRejected?.({ ...candidate, violations: [attemptReductionViolation(error)] })
        }
    }

    return {
        ...state,
        buckets,
        foldedShards: shards.map((shard) => shard.name),
        observationRevisions: revisions,
    }
}

function compareAttemptCandidates(
    left: { readonly shardName: string; readonly observation: PendingUsageAttemptObservation },
    right: { readonly shardName: string; readonly observation: PendingUsageAttemptObservation },
): number {
    return (
        left.observation.observation.admittedAt - right.observation.observation.admittedAt ||
        left.observation.id.localeCompare(right.observation.id) ||
        right.observation.revision - left.observation.revision ||
        left.shardName.localeCompare(right.shardName)
    )
}

function attemptReductionViolation(error: unknown): string {
    return error instanceof Error ? `attempt_reduction:${error.name}` : "attempt_reduction:unknown"
}

export interface UsageAttemptBacklogLoss {
    readonly bucketIds: readonly string[]
    readonly violations: readonly ("backlog_age" | "backlog_capacity")[]
}

export interface UsageAttemptBacklogBoundOptions {
    readonly maxAgeMs?: number
    readonly maxBuckets?: number
    readonly maxBytes?: number
}

export interface UsageAttemptBacklogBoundResult {
    readonly state: UsageAttemptOutboxState
    readonly losses: readonly UsageAttemptBacklogLoss[]
    readonly retainedBytes: number
}

/**
 * Seal low-frequency work and retain one bounded FIFO prefix.
 *
 * An immutable inflight is kept as a unit until its retention age expires. When
 * capacity cannot retain every later bucket, the newest suffix is released with
 * loss evidence so recovery continues draining the oldest surviving work first.
 */
export function boundUsageAttemptBacklog(
    state: UsageAttemptOutboxState,
    now: number,
    options: UsageAttemptBacklogBoundOptions = {},
): UsageAttemptBacklogBoundResult {
    const maxAgeMs = positiveBound(options.maxAgeMs ?? USAGE_ATTEMPT_BACKLOG_MAX_AGE_MS, "backlog age")
    const maxBuckets = positiveBound(options.maxBuckets ?? USAGE_ATTEMPT_BACKLOG_MAX_BUCKETS, "backlog bucket limit")
    const maxBytes = positiveBound(options.maxBytes ?? USAGE_ATTEMPT_BACKLOG_MAX_BYTES, "backlog byte limit")
    if (!Number.isSafeInteger(now) || now < 0) throw new Error("Usage attempt backlog time is invalid")

    let bounded: UsageAttemptOutboxState = {
        ...state,
        buckets: sealOpenAttemptBucketIfDue(state.buckets, now),
    }
    const ageExpired = new Set(
        bounded.buckets.sealed.filter((bucket) => now - (bucket.sealedAt ?? now) >= maxAgeMs).map((bucket) => bucket.bucketId),
    )
    if (bounded.inflight?.bucketIds.some((bucketId) => ageExpired.has(bucketId))) {
        for (const bucketId of bounded.inflight.bucketIds) ageExpired.add(bucketId)
    }
    if (ageExpired.size > 0) bounded = releaseAttemptBuckets(bounded, ageExpired)

    if (attemptBacklogStorageBytes(bounded) > maxBytes || retainedAttemptBucketCount(bounded) > maxBuckets) {
        bounded = { ...bounded, buckets: sealOpenAttemptBucket(bounded.buckets, now) }
    }

    const protectedIds = new Set(bounded.inflight?.bucketIds ?? [])
    const kept: AttemptBucket[] = []
    const capacityDropped: string[] = []
    let capacityReached = false
    for (const bucket of bounded.buckets.sealed) {
        if (protectedIds.has(bucket.bucketId)) {
            kept.push(bucket)
            continue
        }
        if (capacityReached) {
            capacityDropped.push(bucket.bucketId)
            continue
        }
        const candidate = pruneAttemptCheckpoints({ ...bounded, buckets: { sealed: [...kept, bucket] } })
        if (retainedAttemptBucketCount(candidate) > maxBuckets || attemptBacklogStorageBytes(candidate) > maxBytes) {
            capacityReached = true
            capacityDropped.push(bucket.bucketId)
        } else {
            kept.push(bucket)
        }
    }
    if (capacityDropped.length > 0) {
        bounded = releaseAttemptBuckets({ ...bounded, buckets: { sealed: kept } }, new Set(capacityDropped))
    } else if (bounded.buckets.open === undefined) {
        bounded = pruneAttemptCheckpoints({ ...bounded, buckets: { sealed: kept } })
    }

    const losses: UsageAttemptBacklogLoss[] = []
    if (ageExpired.size > 0) losses.push({ bucketIds: [...ageExpired], violations: ["backlog_age"] })
    if (capacityDropped.length > 0) losses.push({ bucketIds: capacityDropped, violations: ["backlog_capacity"] })
    return { state: bounded, losses, retainedBytes: attemptBacklogStorageBytes(bounded) }
}

/** Conservative encoded storage bound for retained buckets and their live dedupe checkpoints. */
export function attemptBacklogStorageBytes(state: UsageAttemptOutboxState): number {
    const checkpointsByBucket = new Map<string, Record<string, UsageAttemptObservationCheckpoint>>()
    for (const [attemptId, checkpoint] of Object.entries(state.observationRevisions)) {
        const entries = checkpointsByBucket.get(checkpoint.bucketId) ?? {}
        entries[attemptId] = checkpoint
        checkpointsByBucket.set(checkpoint.bucketId, entries)
    }
    const buckets = [...state.buckets.sealed, ...(state.buckets.open ? [state.buckets.open] : [])]
    const fixed = {
        policyGeneration: state.policyGeneration,
        pacing: state.pacing,
        foldedShards: state.foldedShards,
        inflight: state.inflight,
    }
    let bytes = encodedBytes(fixed)
    for (const bucket of buckets) {
        bytes += encodedBytes({ bucket, checkpoints: checkpointsByBucket.get(bucket.bucketId) ?? {} }) + 2
    }
    return bytes
}

function retainedAttemptBucketCount(state: UsageAttemptOutboxState): number {
    return state.buckets.sealed.length + (state.buckets.open ? 1 : 0)
}

function releaseAttemptBuckets(state: UsageAttemptOutboxState, released: ReadonlySet<string>): UsageAttemptOutboxState {
    const inflight = state.inflight?.bucketIds.some((bucketId) => released.has(bucketId)) ? undefined : state.inflight
    return pruneAttemptCheckpoints({
        ...state,
        buckets: {
            ...(state.buckets.open && !released.has(state.buckets.open.bucketId) ? { open: state.buckets.open } : {}),
            sealed: state.buckets.sealed.filter((bucket) => !released.has(bucket.bucketId)),
        },
        ...(inflight ? { inflight } : { inflight: undefined }),
    })
}

function pruneAttemptCheckpoints(state: UsageAttemptOutboxState): UsageAttemptOutboxState {
    const retained = new Set([
        ...state.buckets.sealed.map((bucket) => bucket.bucketId),
        ...(state.buckets.open ? [state.buckets.open.bucketId] : []),
    ])
    const revisions = Object.fromEntries(
        Object.entries(state.observationRevisions).filter(([, checkpoint]) => retained.has(checkpoint.bucketId)),
    )
    return { ...state, observationRevisions: revisions }
}

function positiveBound(value: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Usage attempt ${label} is invalid`)
    return value
}

function encodedBytes(value: unknown): number {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
}

export type UsageAttemptBatchDecision =
    | { readonly kind: "none" }
    | {
          readonly kind: "batch"
          readonly state: UsageAttemptOutboxState
          readonly inflight: UsageAttemptInflight
          readonly body: UsageAttemptBodyWire
          readonly bytes: Uint8Array
      }
    | {
          readonly kind: "rejected"
          readonly state: UsageAttemptOutboxState
          readonly bucketIds: readonly string[]
          readonly violations: readonly string[]
      }

export interface UsageAttemptBatchInput extends UsageAttemptBodyValidation {
    readonly now: number
    readonly requestId: string
    readonly client: UsageClientWire
    readonly random?: () => number
}

/** Select the longest complete FIFO bucket prefix that satisfies every effective grant bound. */
export function takeUsageAttemptBatch(state: UsageAttemptOutboxState, input: UsageAttemptBatchInput): UsageAttemptBatchDecision {
    if (state.inflight || !mayStartBatch(state.pacing, input.now)) return { kind: "none" }
    let selected: AttemptBucket[] = []
    let prepared: { body: UsageAttemptBodyWire; bytes: Uint8Array } | undefined
    for (const bucket of state.buckets.sealed) {
        const candidate = [...selected, bucket]
        const body = buildUsageAttemptBody(candidate, input.client)
        const violations = validateUsageAttemptBody(body, input)
        if (violations.length > 0) {
            if (selected.length > 0) break
            return {
                kind: "rejected",
                bucketIds: [bucket.bucketId],
                violations,
                state: pruneAttemptCheckpoints({
                    ...state,
                    buckets: { ...state.buckets, sealed: state.buckets.sealed.slice(1) },
                }),
            }
        }
        selected = candidate
        prepared = { body, bytes: new TextEncoder().encode(JSON.stringify(body)) }
    }
    if (!prepared || selected.length === 0) return { kind: "none" }
    const inflight: UsageAttemptInflight = {
        requestId: input.requestId,
        bodySha256: sha256Hex(prepared.bytes),
        bucketIds: selected.map((bucket) => bucket.bucketId),
        createdAt: input.now,
        attempts: 0,
        notBefore: input.now,
    }
    return {
        kind: "batch",
        inflight,
        body: prepared.body,
        bytes: prepared.bytes,
        state: {
            ...state,
            inflight,
            pacing: reserveAttemptInterval(state.pacing, input.contract, input.now, input.random ?? Math.random),
        },
    }
}

function reserveAttemptInterval(
    pacing: ChannelPacing,
    contract: UsageAttemptBodyValidation["contract"],
    now: number,
    random: () => number,
): ChannelPacing {
    const sample = Math.min(Math.max(random(), 0), 1)
    const jitter = Math.round(sample * contract.newBatchJitterMaxMs)
    return { ...pacing, nextEligibleAt: Math.max(pacing.nextEligibleAt, now + contract.defaultIntervalMs + jitter) }
}

export function dueUsageAttemptReplay(state: UsageAttemptOutboxState, now: number): UsageAttemptInflight | undefined {
    const inflight = state.inflight
    if (!inflight || now < inflight.notBefore || isWaiting(state.pacing, now)) return undefined
    return inflight
}

export function settleUsageAttemptInflight(
    state: UsageAttemptOutboxState,
    requestId: string,
    resolution: UsageInflightResolution,
    now: number,
    random: () => number = Math.random,
): UsageAttemptOutboxState {
    const inflight = state.inflight
    if (!inflight || inflight.requestId !== requestId) return state
    const { inflight: _settled, ...rest } = state
    const releaseBuckets = () =>
        pruneAttemptCheckpoints({
            ...rest,
            buckets: {
                ...state.buckets,
                sealed: state.buckets.sealed.filter((bucket) => !inflight.bucketIds.includes(bucket.bucketId)),
            },
        })
    switch (resolution.kind) {
        case "acknowledged":
            return { ...releaseBuckets(), pacing: afterAcknowledged(state.pacing, "usage", resolution.nextEligibleAt, now) }
        case "wait": {
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
            if (replayBudgetExhausted(attempts, inflight.createdAt, now)) return releaseBuckets()
            return {
                ...state,
                inflight: { ...inflight, attempts, notBefore: now + replayDelayMs(attempts, resolution.retryAfterMs) },
            }
        }
        case "too_large":
        case "discard":
        case "body_lost":
            return releaseBuckets()
    }
}

/**
 * Keep facts across allowed-to-allowed policy revisions. A revocation calls the
 * repository reset path and advances the floor; a stale lower revision cannot
 * reopen an older admission period.
 */
export function alignUsagePolicyEpoch(state: UsageOutboxState, policyEpoch: number): UsageOutboxState {
    if (!Number.isSafeInteger(policyEpoch) || policyEpoch < 0) throw new Error("Usage policy epoch is invalid")
    // A missing document starts at epoch zero. Its continuity is unknown, so the first real policy decision
    // establishes the floor without adopting observations admitted under an earlier epoch. Once established,
    // allowed-to-allowed revisions preserve pending/inflight facts; revocation advances the floor through reset().
    if (state.policyEpoch === 0 && policyEpoch > 0) return emptyUsageOutbox(policyEpoch, state)
    return state
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
export interface UsageObservationRejection {
    readonly shardName: string
    readonly observation: PendingUsageObservation
    readonly violations: readonly string[]
}

export interface UsageFoldOptions {
    readonly client?: UsageClientWire
    readonly currentPolicyEpoch?: number
    readonly onRejected?: (rejection: UsageObservationRejection) => void
}

export function foldUsageShards(
    state: UsageOutboxState,
    shards: readonly SettledUsageShard[],
    now: number,
    options: UsageFoldOptions = {},
): UsageOutboxState {
    const folded = new Set(state.foldedShards)
    const currentSecond = secondStartOf(now)
    const policyCeiling = options.currentPolicyEpoch ?? state.policyEpoch
    let seconds = state.seconds
    for (const shard of shards) {
        if (folded.has(shard.name)) continue
        for (const observation of shard.observations) {
            if (observation.policyEpoch < state.policyEpoch || observation.policyEpoch > policyCeiling) continue
            const startedAt = Math.max(Math.min(secondStartOf(observation.receivedAt), currentSecond), state.sealedThrough)
            try {
                const candidate = mergeSeconds(seconds, [{ startedAt, tally: observation.tally }])
                if (options.client) {
                    const candidateSecond = candidate.find((second) => second.startedAt === startedAt)
                    const prepared = candidateSecond ? prepareUsageBody([candidateSecond], options.client, 0) : undefined
                    if (!prepared || prepared.violations.length > 0) {
                        options.onRejected?.({
                            shardName: shard.name,
                            observation,
                            violations: prepared?.violations ?? ["no_activity"],
                        })
                        continue
                    }
                }
                seconds = candidate
            } catch (error) {
                options.onRejected?.({ shardName: shard.name, observation, violations: reductionViolations(error) })
            }
        }
    }
    const capped = capPendingSeconds(seconds)
    return {
        ...state,
        seconds: capped.seconds,
        droppedSeconds: checkedDroppedAdd(state.droppedSeconds, capped.dropped),
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
    const eligible = selectBatchSeconds(complete)
    if (eligible.length === 0) return { kind: "none" }

    const reportedDropped = Math.min(state.droppedSeconds, USAGE_MAX_ACTIVE_SECONDS)
    let selected: UsageSecond[] = []
    let prepared: PreparedUsageBody | undefined
    for (const second of eligible) {
        const candidate = [...selected, second]
        const next = prepareUsageBody(candidate, input.client, reportedDropped)
        if (next.violations.length > 0) {
            if (selected.length > 0) break
            const remaining = state.seconds.filter((entry) => entry !== second)
            const sealedThrough = Math.max(state.sealedThrough, second.startedAt + USAGE_SECOND_MS)
            return {
                kind: "rejected",
                violations: next.violations,
                state: {
                    ...state,
                    seconds: remaining,
                    sealedThrough,
                    droppedSeconds: checkedDroppedAdd(state.droppedSeconds, 1),
                },
            }
        }
        selected = candidate
        prepared = next
    }
    if (!prepared || selected.length === 0) return { kind: "none" }

    const taken = new Set(selected.map((second) => second.startedAt))
    const remaining = state.seconds.filter((second) => !taken.has(second.startedAt))
    const sealedThrough = Math.max(state.sealedThrough, (selected.at(-1) as UsageSecond).startedAt + USAGE_SECOND_MS)
    const inflight: UsageInflight = {
        requestId: input.requestId,
        bodySha256: sha256Hex(prepared.bytes),
        seconds: selected,
        droppedSeconds: reportedDropped,
        createdAt: now,
        attempts: 0,
        notBefore: now,
    }
    return {
        kind: "batch",
        inflight,
        body: prepared.body,
        bytes: prepared.bytes,
        state: {
            ...state,
            seconds: remaining,
            sealedThrough,
            droppedSeconds: state.droppedSeconds - reportedDropped,
            inflight,
            pacing: reserveInterval(state.pacing, "usage", now),
        },
    }
}

interface PreparedUsageBody {
    readonly body: UsageBodyWire
    readonly bytes: Uint8Array
    readonly violations: readonly string[]
}

function prepareUsageBody(seconds: readonly UsageSecond[], client: UsageClientWire, droppedSeconds: number): PreparedUsageBody {
    let body: UsageBodyWire | undefined
    try {
        body = buildUsageBody(seconds, client, droppedSeconds)
    } catch (error) {
        return {
            body: emptyRejectedBody(client),
            bytes: new Uint8Array(),
            violations: reductionViolations(error),
        }
    }
    if (!body) return { body: emptyRejectedBody(client), bytes: new Uint8Array(), violations: ["no_activity"] }
    const bytes = new TextEncoder().encode(JSON.stringify(body))
    const violations = validateUsageBody(body)
    if (bytes.byteLength > USAGE_BODY_LIMIT_BYTES) violations.push("body_size")
    return { body, bytes, violations: [...new Set(violations)] }
}

function emptyRejectedBody(client: UsageClientWire): UsageBodyWire {
    return {
        schema_version: 3,
        client,
        window: { started_at: 0, ended_at: USAGE_SECOND_MS, active_seconds: 0, dropped_seconds: 0 },
        sessions_started: 0,
        facts: [],
    }
}

function reductionViolations(error: unknown): readonly string[] {
    if (error instanceof UsageTallyReductionError) return [`${error.code}:${error.path}`]
    return ["reduction_failed"]
}

function checkedDroppedAdd(left: number, right: number): number {
    const sum = left + right
    if (!Number.isSafeInteger(sum) || sum < 0) throw new UsageTallyReductionError("integer_overflow", "dropped_seconds")
    return sum
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
    return {
        ...state,
        droppedSeconds: checkedDroppedAdd(
            checkedDroppedAdd(state.droppedSeconds, inflight.droppedSeconds),
            inflight.seconds.length,
        ),
    }
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
