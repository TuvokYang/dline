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
} from "../contracts/pacing"
import {
    buildUsageAttemptBody,
    type UsageAttemptBodyValidation,
    type UsageAttemptBodyWire,
    type UsageClientWire,
    validateUsageAttemptBody,
} from "../contracts/usageBody"
import {
    type AttemptBucket,
    type AttemptBucketState,
    appendAttemptToBucketsWithTarget,
    emptyAttemptBucketState,
    sealOpenAttemptBucket,
    sealOpenAttemptBucketIfDue,
} from "./attemptBucket"
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

export type UsageInflightResolution =
    | Extract<DeliveryOutcome, { kind: "acknowledged" | "replay" | "wait" | "too_large" | "discard" }>
    | { readonly kind: "body_lost" }

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
export function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex")
}
