import fs from "node:fs/promises"
import path from "node:path"
import { writeFileAtomic, writeJsonAtomic } from "@shared/storage/atomic-file"
import { type ChannelPacing } from "@/services/telemetry/remote/contracts/pacing"
import { type AttemptBucket, validateAttemptBucket } from "@/services/telemetry/remote/usage/attemptBucket"
import type { UsageSecond } from "@/services/telemetry/remote/usage/usageBatch"
import {
    emptyUsageAttemptOutbox,
    emptyUsageOutbox,
    sha256Hex,
    type UsageAttemptInflight,
    type UsageAttemptObservationCheckpoint,
    type UsageAttemptOutboxState,
    type UsageInflight,
    type UsageOutboxState,
} from "@/services/telemetry/remote/usage/usageOutbox"
import { parseUsageTally } from "@/services/telemetry/remote/usage/usageTally"
import { FileLock } from "../backend/jsonl/FileLock"
import type { OtelStorageLayout } from "./OtelStorageLayout"
import { type QuarantineObserver, quarantineDocument } from "./quarantine"
import {
    decideSenderClaim,
    type SenderClaimMemory,
    type SenderLease,
    type SenderTurns,
    type SenderWaiter,
    type UsageSenderGrant,
    type UsageSenderTurnEvent,
} from "./usageSenderTurn"

export type { UsageSenderGrant, UsageSenderTurnEvent } from "./usageSenderTurn"

/**
 * Version 3 holds fact tallies gathered per second, and is the only version this
 * client writes or reads.
 *
 * There is no migration from an earlier document: its tallies were per purpose
 * and per model, which a fact-keyed body cannot hold, and an outbox is a queue of
 * not-yet-sent claims rather than durable history. An unreadable document is
 * quarantined and delivery starts from an empty queue.
 */
export const USAGE_OUTBOX_SCHEMA_VERSION = 3
export const USAGE_ATTEMPT_OUTBOX_SCHEMA_VERSION = 4
/** How long a sender owns delivery without renewing; longer than one HTTP attempt, short enough to take over a dead window. */
export const USAGE_SENDER_LEASE_MS = 90_000
const LOCK_ACQUIRE_ATTEMPTS = 50
const BODY_SUFFIX = ".bin"
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,55}$/i

interface OutboxDocument extends SenderTurns {
    readonly state: UsageOutboxState
}

interface AttemptOutboxDocument extends SenderTurns {
    readonly state: UsageAttemptOutboxState
}

/** A claim's result: the grant, or what the queued window remembers until its next claim. */
interface ClaimOutcome {
    readonly grant?: UsageSenderGrant
    readonly memory?: SenderClaimMemory
    readonly event?: UsageSenderTurnEvent
}

type LatestOutbox =
    | { readonly status: "valid"; readonly document: OutboxDocument }
    | { readonly status: "missing" }
    | { readonly status: "unsupported" }

type LatestAttemptOutbox =
    | { readonly status: "valid"; readonly document: AttemptOutboxDocument }
    | { readonly status: "missing" | "legacy" | "malformed" | "unsupported" }

export type UsageAttemptActivation = "activated" | "active" | "unsupported"

export interface UsageAttemptLossEvidence {
    readonly kind: "validation" | "delivery"
    readonly bucketIds: readonly string[]
    readonly violations: readonly string[]
    readonly recordedAt: number
}

export type UsageOutboxCommit<T> = { readonly status: "committed"; readonly result: T } | { readonly status: "fenced" }

export interface UsageOutboxRepositoryOptions {
    readonly clock?: () => number
    readonly leaseMs?: number
    /** Told when an unreadable outbox was moved aside; its queue and lease start over. */
    readonly onQuarantine?: QuarantineObserver
    /** Told when this window hands its turn on or takes the lease from a holder past its turn. */
    readonly onSenderTurn?: (event: UsageSenderTurnEvent) => void
}

/**
 * Owner of `telemetry/remote/usage/outbox.json` and the exact request bodies
 * beside it.
 *
 * The sender lease, the machine delivery gate, pending minutes and the inflight
 * manifest share one document and one short lock, so checking the lease and
 * changing the queue happen in a single critical section. The lock is never held
 * across HTTP: a sender sends outside it and acknowledges inside it, and an
 * acknowledgement from a sender whose lease lapsed is fenced off.
 *
 * The lease is taken in turns (see `usageSenderTurn.ts`), so no window keeps
 * delivery to itself while others, of this build or an older one, wait.
 */
export class UsageOutboxRepository {
    private readonly lock = new FileLock({ maxAcquireAttempts: LOCK_ACQUIRE_ATTEMPTS })
    private readonly clock: () => number
    private readonly leaseMs: number
    private readonly onQuarantine: QuarantineObserver | undefined
    private readonly onSenderTurn: ((event: UsageSenderTurnEvent) => void) | undefined
    /** What each waiting owner remembers between claims; an older build's rewrite cannot erase it. */
    private readonly claimMemory = new Map<string, SenderClaimMemory>()

    constructor(
        private readonly layout: OtelStorageLayout,
        options: UsageOutboxRepositoryOptions = {},
    ) {
        this.clock = options.clock ?? Date.now
        this.leaseMs = options.leaseMs ?? USAGE_SENDER_LEASE_MS
        this.onQuarantine = options.onQuarantine
        this.onSenderTurn = options.onSenderTurn
    }

    /**
     * Take or renew the sender lease, or queue for it. `undefined` means another
     * window sends now, this window's turn just ended, or a newer Dline owns the
     * outbox.
     */
    async claim(ownerId: string): Promise<UsageSenderGrant | undefined> {
        const claimed = await this.mutate<ClaimOutcome>((document, now) => {
            const decision = decideSenderClaim({
                turns: document,
                ownerId,
                now,
                leaseMs: this.leaseMs,
                memory: this.claimMemory.get(ownerId),
            })
            if (decision.kind === "kept") return { result: { grant: decision.grant } }
            // Built from the decided turns alone, so a lease the decision ended does not survive from the old document.
            const { generation, lease, waiting } = decision.turns
            const next: OutboxDocument = { generation, ...(lease ? { lease } : {}), waiting, state: document.state }
            if (decision.kind === "granted") return { document: next, result: { grant: decision.grant, event: decision.event } }
            return { document: next, result: { memory: decision.memory, event: decision.event } }
        })
        if (!claimed) return undefined
        if (claimed.memory) this.claimMemory.set(ownerId, claimed.memory)
        else this.claimMemory.delete(ownerId)
        if (claimed.event) this.onSenderTurn?.(claimed.event)
        return claimed.grant
    }

    /**
     * Destructively switch the machine authority to schema 4 after capability admission.
     * Legacy pending facts are intentionally not migrated or read by the new authority.
     */
    async activateAttempts(policyGeneration: number): Promise<UsageAttemptActivation> {
        if (!isCount(policyGeneration)) throw new Error("Usage attempt policy generation is invalid")
        await fs.mkdir(this.layout.usageDir, { recursive: true })
        return this.lock.withLock(this.layout.usageOutboxPath, async () => {
            const latest = await this.readAttemptParsed()
            if (latest.status === "valid") return "active"
            if (latest.status === "unsupported") return "unsupported"
            if (latest.status === "malformed") {
                if (await quarantineDocument(this.layout.usageOutboxPath, this.layout.remoteQuarantineDir, this.clock())) {
                    this.onQuarantine?.(path.basename(this.layout.usageOutboxPath))
                }
            }
            const document: AttemptOutboxDocument = {
                generation: 0,
                waiting: {},
                state: emptyUsageAttemptOutbox(policyGeneration),
            }
            await writeJsonAtomic(this.layout.usageOutboxPath, serializeAttemptDocument(document), { fsync: true })
            // The schema 4 document no longer names any schema 3 body. Removing them while holding the same lock
            // prevents an old sender from publishing a manifest between cutover and cleanup.
            await this.removeBodies()
            return "activated"
        })
    }

    /** Claim or renew the sender lease only when schema 4 is already active. */
    async claimAttempts(ownerId: string): Promise<UsageSenderGrant | undefined> {
        const claimed = await this.mutateAttempts<ClaimOutcome>((document, now) => {
            const decision = decideSenderClaim({
                turns: document,
                ownerId,
                now,
                leaseMs: this.leaseMs,
                memory: this.claimMemory.get(ownerId),
            })
            if (decision.kind === "kept") return { result: { grant: decision.grant } }
            const { generation, lease, waiting } = decision.turns
            const next: AttemptOutboxDocument = {
                generation,
                ...(lease ? { lease } : {}),
                waiting,
                state: document.state,
            }
            if (decision.kind === "granted") return { document: next, result: { grant: decision.grant, event: decision.event } }
            return { document: next, result: { memory: decision.memory, event: decision.event } }
        })
        if (!claimed) return undefined
        if (claimed.memory) this.claimMemory.set(ownerId, claimed.memory)
        else this.claimMemory.delete(ownerId)
        if (claimed.event) this.onSenderTurn?.(claimed.event)
        return claimed.grant
    }

    async releaseAttempts(grant: UsageSenderGrant): Promise<void> {
        await this.mutateAttempts((document) => {
            if (!holds(document.lease, grant)) return { result: undefined }
            const { lease: _released, ...rest } = document
            return { document: rest, result: undefined }
        })
    }

    async transactAttempts<T>(
        grant: UsageSenderGrant,
        change: (
            state: UsageAttemptOutboxState,
            now: number,
        ) =>
            | Promise<{ readonly state: UsageAttemptOutboxState; readonly result: T }>
            | { readonly state: UsageAttemptOutboxState; readonly result: T },
    ): Promise<UsageOutboxCommit<T>> {
        const commit = await this.mutateAttempts<UsageOutboxCommit<T>>(async (document, now) => {
            const lease = document.lease
            if (!holds(lease, grant) || (lease as SenderLease).expiresAt <= now) return { result: { status: "fenced" } as const }
            const changed = await change(document.state, now)
            return {
                document: { ...document, state: changed.state },
                result: { status: "committed", result: changed.result } as const,
            }
        })
        return commit ?? { status: "fenced" }
    }

    async readAttempts(): Promise<UsageAttemptOutboxState | undefined> {
        const latest = await this.readAttemptParsed()
        return latest.status === "valid" ? latest.document.state : undefined
    }

    async resetAttempts(policyGeneration: number): Promise<boolean> {
        await fs.mkdir(this.layout.usageDir, { recursive: true })
        return this.lock.withLock(this.layout.usageOutboxPath, async () => {
            const latest = await this.readAttemptParsed()
            if (latest.status !== "valid" || latest.document.state.policyGeneration >= policyGeneration) return false
            const next = {
                ...latest.document,
                state: emptyUsageAttemptOutbox(policyGeneration, latest.document.state),
            }
            await writeJsonAtomic(this.layout.usageOutboxPath, serializeAttemptDocument(next), { fsync: true })
            await this.removeBodies()
            return true
        })
    }

    /** Remove orphaned schema 4 bodies only while the caller still owns the exact live lease generation. */
    async removeAttemptBodies(grant: UsageSenderGrant, keepRequestId?: string): Promise<boolean> {
        const removed = await this.mutateAttempts<boolean>(async (document, now) => {
            const lease = document.lease
            if (!holds(lease, grant) || (lease as SenderLease).expiresAt <= now) return { result: false }
            await this.removeBodies(keepRequestId)
            return { result: true }
        })
        return removed ?? false
    }

    /** Persist bounded, idempotent loss evidence before a fenced transaction releases schema 4 buckets. */
    async writeAttemptLoss(evidence: UsageAttemptLossEvidence): Promise<void> {
        if (!Number.isSafeInteger(evidence.recordedAt) || evidence.recordedAt < 0) {
            throw new Error("Usage attempt loss time is invalid")
        }
        if (evidence.bucketIds.length === 0 || evidence.bucketIds.some((id) => !/^[A-Za-z0-9:_-]{1,128}$/u.test(id))) {
            throw new Error("Usage attempt loss bucket identity is invalid")
        }
        if (
            evidence.violations.length === 0 ||
            evidence.violations.some((violation) => !/^[a-z0-9_:.-]{1,128}$/u.test(violation))
        ) {
            throw new Error("Usage attempt loss violation is invalid")
        }
        const identity = new TextEncoder().encode(
            JSON.stringify({ kind: evidence.kind, bucket_ids: evidence.bucketIds, violations: evidence.violations }),
        )
        const fileName = `usage-attempt-loss-${sha256Hex(identity).slice(0, 32)}.json`
        await fs.mkdir(this.layout.remoteQuarantineDir, { recursive: true })
        await writeJsonAtomic(
            path.join(this.layout.remoteQuarantineDir, fileName),
            {
                schema_version: 1,
                kind: "usage_attempt_bucket_loss",
                stage: evidence.kind,
                bucket_ids: [...evidence.bucketIds],
                violations: [...evidence.violations],
                recorded_at: evidence.recordedAt,
            },
            { fsync: true },
        )
    }

    /** Give the lease up so another window can send at once; a lease that changed hands is left alone. */
    async release(grant: UsageSenderGrant): Promise<void> {
        await this.mutate((document) => {
            if (!holds(document.lease, grant)) return { result: undefined }
            const { lease: _released, ...rest } = document
            return { document: rest, result: undefined }
        })
    }

    /**
     * Change the outbox as the current lease holder. The change sees the latest
     * state and may write an exact body before returning; nothing is committed
     * when the lease lapsed or changed hands.
     */
    async transact<T>(
        grant: UsageSenderGrant,
        change: (
            state: UsageOutboxState,
            now: number,
        ) =>
            | Promise<{ readonly state: UsageOutboxState; readonly result: T }>
            | { readonly state: UsageOutboxState; readonly result: T },
    ): Promise<UsageOutboxCommit<T>> {
        const commit = await this.mutate<UsageOutboxCommit<T>>(async (document, now) => {
            const lease = document.lease
            if (!holds(lease, grant) || (lease as SenderLease).expiresAt <= now) return { result: { status: "fenced" } as const }
            const changed = await change(document.state, now)
            return {
                document: { ...document, state: changed.state },
                result: { status: "committed", result: changed.result } as const,
            }
        })
        return commit ?? { status: "fenced" }
    }

    /**
     * Drop every pending window and the inflight, from any window, for example
     * when consent is withdrawn. The lease and the server gate stay.
     */
    async reset(policyEpoch: number): Promise<boolean> {
        const reset = await this.mutate((document) => {
            // Policy epochs are monotonic. A stale revocation must not erase state
            // already reset or admitted by a newer policy generation.
            if (document.state.policyEpoch >= policyEpoch) return { result: false }
            return {
                document: { ...document, state: emptyUsageOutbox(policyEpoch, document.state) },
                result: true,
            }
        })
        if (reset) await this.removeBodies()
        return reset ?? false
    }

    /** Lock-free read for diagnostics and tests; `undefined` when absent, unreadable or newer. */
    async read(): Promise<UsageOutboxState | undefined> {
        const latest = await this.readParsed()
        return latest.status === "valid" ? latest.document.state : undefined
    }

    /** Persist the exact bytes of a batch before any manifest may name them. */
    async writeBody(requestId: string, body: Uint8Array): Promise<void> {
        await writeFileAtomic(this.bodyPath(requestId), body, { fsync: true })
    }

    /** The exact bytes of the inflight, or `undefined` when they are missing or no longer match the manifest. */
    async readBody(inflight: Pick<UsageInflight, "requestId" | "bodySha256">): Promise<Uint8Array | undefined> {
        let bytes: Uint8Array
        try {
            bytes = await fs.readFile(this.bodyPath(inflight.requestId))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
            throw error
        }
        return sha256Hex(bytes) === inflight.bodySha256 ? bytes : undefined
    }

    /** Remove every body except the one the current inflight still needs. */
    async removeBodies(keepRequestId?: string): Promise<void> {
        const names = await fs.readdir(this.layout.usageInflightDir).catch(() => [] as string[])
        for (const name of names) {
            if (keepRequestId !== undefined && name === `${keepRequestId}${BODY_SUFFIX}`) continue
            await fs.rm(path.join(this.layout.usageInflightDir, name), { force: true })
        }
    }

    private bodyPath(requestId: string): string {
        if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("Usage request ID must be a UUID")
        return path.join(this.layout.usageInflightDir, `${requestId}${BODY_SUFFIX}`)
    }

    private async mutate<T>(
        change: (
            document: OutboxDocument,
            now: number,
        ) =>
            | Promise<{ readonly document?: OutboxDocument; readonly result: T }>
            | { readonly document?: OutboxDocument; readonly result: T },
    ): Promise<T | undefined> {
        await fs.mkdir(this.layout.usageDir, { recursive: true })
        return this.lock.withLock(this.layout.usageOutboxPath, async () => {
            const latest = await this.readLatestForWrite()
            // A newer Dline owns the document: this build neither sends nor rewrites it.
            if (latest.status === "unsupported") return undefined
            const previous: OutboxDocument =
                latest.status === "valid" ? latest.document : { generation: 0, waiting: {}, state: emptyUsageOutbox(0) }
            const changed = await change(previous, this.clock())
            if (changed.document) {
                const next = serialize(changed.document)
                const unchanged = latest.status === "valid" && JSON.stringify(serialize(previous)) === JSON.stringify(next)
                if (!unchanged) await writeJsonAtomic(this.layout.usageOutboxPath, next, { fsync: true })
            }
            return changed.result
        })
    }

    private async mutateAttempts<T>(
        change: (
            document: AttemptOutboxDocument,
            now: number,
        ) =>
            | Promise<{ readonly document?: AttemptOutboxDocument; readonly result: T }>
            | { readonly document?: AttemptOutboxDocument; readonly result: T },
    ): Promise<T | undefined> {
        await fs.mkdir(this.layout.usageDir, { recursive: true })
        return this.lock.withLock(this.layout.usageOutboxPath, async () => {
            const latest = await this.readAttemptParsed()
            if (latest.status !== "valid") return undefined
            const previous = latest.document
            const changed = await change(previous, this.clock())
            if (changed.document) {
                const next = serializeAttemptDocument(changed.document)
                const unchanged = JSON.stringify(serializeAttemptDocument(previous)) === JSON.stringify(next)
                if (!unchanged) await writeJsonAtomic(this.layout.usageOutboxPath, next, { fsync: true })
            }
            return changed.result
        })
    }

    private async readAttemptParsed(): Promise<LatestAttemptOutbox> {
        let raw: string
        try {
            raw = await fs.readFile(this.layout.usageOutboxPath, "utf8")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" }
            throw error
        }
        try {
            return parseAttemptDocument(JSON.parse(raw))
        } catch {
            return { status: "malformed" }
        }
    }

    private async readLatestForWrite(): Promise<LatestOutbox> {
        const parsed = await this.readParsed()
        if (parsed.status !== "malformed") return parsed
        if (await quarantineDocument(this.layout.usageOutboxPath, this.layout.remoteQuarantineDir, this.clock())) {
            this.onQuarantine?.(path.basename(this.layout.usageOutboxPath))
        }
        return { status: "missing" }
    }

    private async readParsed(): Promise<LatestOutbox | { readonly status: "malformed" }> {
        let raw: string
        try {
            raw = await fs.readFile(this.layout.usageOutboxPath, "utf8")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" }
            throw error
        }
        try {
            return parseDocument(JSON.parse(raw))
        } catch {
            return { status: "malformed" }
        }
    }
}

function holds(lease: SenderLease | undefined, grant: UsageSenderGrant): lease is SenderLease {
    return lease !== undefined && lease.ownerId === grant.ownerId && lease.generation === grant.generation
}

function serialize(document: OutboxDocument): Record<string, unknown> {
    const { state } = document
    const waiting = Object.entries(document.waiting)
    return {
        schema_version: USAGE_OUTBOX_SCHEMA_VERSION,
        generation: document.generation,
        ...(document.lease
            ? {
                  lease: {
                      owner_id: document.lease.ownerId,
                      generation: document.lease.generation,
                      expires_at: document.lease.expiresAt,
                      ...(document.lease.grantedAt === undefined ? {} : { granted_at: document.lease.grantedAt }),
                  },
              }
            : {}),
        ...(waiting.length > 0
            ? {
                  waiting: Object.fromEntries(
                      waiting.map(([ownerId, waiter]) => [ownerId, { since: waiter.since, seen_at: waiter.seenAt }]),
                  ),
              }
            : {}),
        state: {
            policy_epoch: state.policyEpoch,
            pacing: {
                next_eligible_at: state.pacing.nextEligibleAt,
                wait_until: state.pacing.waitUntil,
                consecutive_waits: state.pacing.consecutiveWaits,
            },
            sealed_through: state.sealedThrough,
            dropped_seconds: state.droppedSeconds,
            seconds: state.seconds.map(serializeSecond),
            folded_shards: state.foldedShards,
            ...(state.inflight
                ? {
                      inflight: {
                          request_id: state.inflight.requestId,
                          body_sha256: state.inflight.bodySha256,
                          seconds: state.inflight.seconds.map(serializeSecond),
                          dropped_seconds: state.inflight.droppedSeconds,
                          created_at: state.inflight.createdAt,
                          attempts: state.inflight.attempts,
                          not_before: state.inflight.notBefore,
                      },
                  }
                : {}),
        },
    }
}

function serializeSecond(second: UsageSecond): Record<string, unknown> {
    return { started_at: second.startedAt, tally: second.tally }
}

function serializeAttemptDocument(document: AttemptOutboxDocument): Record<string, unknown> {
    const { state } = document
    const waiting = Object.entries(document.waiting)
    return {
        schema_version: USAGE_ATTEMPT_OUTBOX_SCHEMA_VERSION,
        generation: document.generation,
        ...(document.lease
            ? {
                  lease: {
                      owner_id: document.lease.ownerId,
                      generation: document.lease.generation,
                      expires_at: document.lease.expiresAt,
                      ...(document.lease.grantedAt === undefined ? {} : { granted_at: document.lease.grantedAt }),
                  },
              }
            : {}),
        ...(waiting.length > 0
            ? {
                  waiting: Object.fromEntries(
                      waiting.map(([ownerId, waiter]) => [ownerId, { since: waiter.since, seen_at: waiter.seenAt }]),
                  ),
              }
            : {}),
        state: {
            policy_generation: state.policyGeneration,
            pacing: {
                next_eligible_at: state.pacing.nextEligibleAt,
                wait_until: state.pacing.waitUntil,
                consecutive_waits: state.pacing.consecutiveWaits,
            },
            ...(state.buckets.open ? { open_bucket: state.buckets.open } : {}),
            sealed_buckets: state.buckets.sealed,
            folded_shards: state.foldedShards,
            observation_revisions: Object.fromEntries(
                Object.entries(state.observationRevisions).map(([id, checkpoint]) => [
                    id,
                    { revision: checkpoint.revision, bucket_id: checkpoint.bucketId },
                ]),
            ),
            ...(state.inflight
                ? {
                      inflight: {
                          request_id: state.inflight.requestId,
                          body_sha256: state.inflight.bodySha256,
                          bucket_ids: state.inflight.bucketIds,
                          created_at: state.inflight.createdAt,
                          attempts: state.inflight.attempts,
                          not_before: state.inflight.notBefore,
                      },
                  }
                : {}),
        },
    }
}

function parseAttemptDocument(value: unknown): LatestAttemptOutbox {
    if (!isRecord(value)) return { status: "malformed" }
    const schemaVersion = value.schema_version
    if (!isCount(schemaVersion)) return { status: "malformed" }
    if (schemaVersion > USAGE_ATTEMPT_OUTBOX_SCHEMA_VERSION) return { status: "unsupported" }
    if (schemaVersion < USAGE_ATTEMPT_OUTBOX_SCHEMA_VERSION) return { status: "legacy" }
    if (!isCount(value.generation)) return { status: "malformed" }
    let lease: SenderLease | undefined
    if (value.lease !== undefined) {
        lease = parseLease(value.lease)
        if (!lease || lease.generation > value.generation) return { status: "malformed" }
    }
    const state = parseAttemptState(value.state)
    if (!state) return { status: "malformed" }
    const waiting = parseWaiting(value.waiting)
    return { status: "valid", document: { generation: value.generation, ...(lease ? { lease } : {}), waiting, state } }
}

function parseAttemptState(value: unknown): UsageAttemptOutboxState | undefined {
    if (!isRecord(value) || !isCount(value.policy_generation)) return undefined
    const pacing = parsePacing(value.pacing)
    const foldedShards = value.folded_shards
    const revisions = parseAttemptRevisions(value.observation_revisions)
    if (!pacing || !Array.isArray(foldedShards) || !foldedShards.every(isString) || !revisions) return undefined
    const sealedValues = value.sealed_buckets
    if (!Array.isArray(sealedValues)) return undefined
    const sealed: AttemptBucket[] = []
    for (const entry of sealedValues) {
        const bucket = parseAttemptBucket(entry)
        if (!bucket || bucket.sealedAt === undefined) return undefined
        sealed.push(bucket)
    }
    let open: AttemptBucket | undefined
    if (value.open_bucket !== undefined) {
        open = parseAttemptBucket(value.open_bucket)
        if (!open || open.sealedAt !== undefined) return undefined
    }
    const retainedBucketIds = new Set([...sealed.map((bucket) => bucket.bucketId), ...(open ? [open.bucketId] : [])])
    if (Object.values(revisions).some((checkpoint) => !retainedBucketIds.has(checkpoint.bucketId))) return undefined
    let inflight: UsageAttemptInflight | undefined
    if (value.inflight !== undefined) {
        inflight = parseAttemptInflight(value.inflight)
        if (!inflight || inflight.bucketIds.some((id) => !sealed.some((bucket) => bucket.bucketId === id))) return undefined
    }
    return {
        policyGeneration: value.policy_generation,
        pacing,
        buckets: { ...(open ? { open } : {}), sealed },
        foldedShards,
        observationRevisions: revisions,
        ...(inflight ? { inflight } : {}),
    }
}

function parseAttemptInflight(value: unknown): UsageAttemptInflight | undefined {
    if (!isRecord(value)) return undefined
    const {
        request_id: requestId,
        body_sha256: bodySha256,
        bucket_ids: bucketIds,
        created_at: createdAt,
        attempts,
        not_before: notBefore,
    } = value
    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) return undefined
    if (typeof bodySha256 !== "string" || !/^[0-9a-f]{64}$/u.test(bodySha256)) return undefined
    if (!Array.isArray(bucketIds) || bucketIds.length === 0 || !bucketIds.every(isString)) return undefined
    if (!isCount(createdAt) || !isCount(attempts) || !isCount(notBefore)) return undefined
    return { requestId, bodySha256, bucketIds, createdAt, attempts, notBefore }
}

function parseAttemptBucket(value: unknown): AttemptBucket | undefined {
    if (!isRecord(value)) return undefined
    try {
        validateAttemptBucket(value as unknown as AttemptBucket)
        return value as unknown as AttemptBucket
    } catch {
        return undefined
    }
}

function parseAttemptRevisions(value: unknown): Record<string, UsageAttemptObservationCheckpoint> | undefined {
    if (!isRecord(value)) return undefined
    const revisions: Record<string, UsageAttemptObservationCheckpoint> = {}
    for (const [id, checkpoint] of Object.entries(value)) {
        if (id.length < 1 || id.length > 512 || !isRecord(checkpoint)) return undefined
        if (!isCount(checkpoint.revision) || typeof checkpoint.bucket_id !== "string") return undefined
        if (!/^[A-Za-z0-9:_-]{1,128}$/u.test(checkpoint.bucket_id)) return undefined
        revisions[id] = { revision: checkpoint.revision, bucketId: checkpoint.bucket_id }
    }
    return revisions
}

function parseDocument(value: unknown): LatestOutbox | { readonly status: "malformed" } {
    if (!isRecord(value)) return { status: "malformed" }
    const schemaVersion = value.schema_version
    // A newer Dline owns a document this build does not understand: it is neither
    // rewritten nor sent from, because guessing at its queue would corrupt it.
    if (isCount(schemaVersion) && schemaVersion > USAGE_OUTBOX_SCHEMA_VERSION) return { status: "unsupported" }
    if (schemaVersion !== USAGE_OUTBOX_SCHEMA_VERSION) return { status: "malformed" }
    if (!isCount(value.generation)) return { status: "malformed" }
    let lease: SenderLease | undefined
    if (value.lease !== undefined) {
        lease = parseLease(value.lease)
        if (!lease || lease.generation > value.generation) return { status: "malformed" }
    }
    const state = parseState(value.state)
    if (!state) return { status: "malformed" }
    const waiting = parseWaiting(value.waiting)
    return { status: "valid", document: { generation: value.generation, ...(lease ? { lease } : {}), waiting, state } }
}

/**
 * The queue is advisory: an entry this build cannot read is dropped instead of
 * quarantining the outbox, and its window re-queues on its next claim.
 */
function parseWaiting(value: unknown): Record<string, SenderWaiter> {
    if (!isRecord(value)) return {}
    const waiting: Record<string, SenderWaiter> = {}
    for (const [ownerId, entry] of Object.entries(value)) {
        if (ownerId.length === 0 || !isRecord(entry) || !isCount(entry.since) || !isCount(entry.seen_at)) continue
        waiting[ownerId] = { since: entry.since, seenAt: entry.seen_at }
    }
    return waiting
}

function parseLease(value: unknown): SenderLease | undefined {
    if (!isRecord(value) || typeof value.owner_id !== "string" || value.owner_id.length === 0) return undefined
    if (!isCount(value.generation) || value.generation < 1 || !isCount(value.expires_at)) return undefined
    // An unreadable turn start counts like a missing one: the holder's turn restarts on its next renewal.
    const grantedAt = isCount(value.granted_at) ? { grantedAt: value.granted_at } : {}
    return { ownerId: value.owner_id, generation: value.generation, expiresAt: value.expires_at, ...grantedAt }
}

function parseState(value: unknown): UsageOutboxState | undefined {
    if (!isRecord(value)) return undefined
    const { policy_epoch: policyEpoch, sealed_through: sealedThrough, dropped_seconds: droppedSeconds } = value
    if (!isCount(policyEpoch) || !isCount(sealedThrough) || !isCount(droppedSeconds)) return undefined
    const pacing = parsePacing(value.pacing)
    const seconds = parseSeconds(value.seconds)
    const foldedShards = value.folded_shards
    if (!pacing || !seconds || !Array.isArray(foldedShards) || !foldedShards.every(isString)) return undefined
    let inflight: UsageInflight | undefined
    if (value.inflight !== undefined) {
        inflight = parseInflight(value.inflight)
        if (!inflight) return undefined
    }
    return {
        policyEpoch,
        pacing,
        sealedThrough,
        droppedSeconds,
        seconds,
        foldedShards,
        ...(inflight ? { inflight } : {}),
    }
}

function parsePacing(value: unknown): ChannelPacing | undefined {
    if (!isRecord(value)) return undefined
    const { next_eligible_at: nextEligibleAt, wait_until: waitUntil, consecutive_waits: consecutiveWaits } = value
    if (!isCount(nextEligibleAt) || !isCount(waitUntil) || !isCount(consecutiveWaits)) return undefined
    return { nextEligibleAt, waitUntil, consecutiveWaits }
}

function parseInflight(value: unknown): UsageInflight | undefined {
    if (!isRecord(value)) return undefined
    const { request_id: requestId, body_sha256: bodySha256, created_at: createdAt, not_before: notBefore } = value
    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) return undefined
    if (typeof bodySha256 !== "string" || !/^[0-9a-f]{64}$/.test(bodySha256)) return undefined
    const seconds = parseSeconds(value.seconds)
    if (!seconds || !isCount(value.dropped_seconds) || !isCount(createdAt) || !isCount(value.attempts) || !isCount(notBefore)) {
        return undefined
    }
    return {
        requestId,
        bodySha256,
        seconds,
        droppedSeconds: value.dropped_seconds,
        createdAt,
        attempts: value.attempts,
        notBefore,
    }
}

function parseSeconds(value: unknown): UsageSecond[] | undefined {
    if (!Array.isArray(value)) return undefined
    const seconds: UsageSecond[] = []
    for (const entry of value) {
        if (!isRecord(entry) || !isCount(entry.started_at)) return undefined
        const tally = parseUsageTally(entry.tally)
        if (!tally) return undefined
        seconds.push({ startedAt: entry.started_at, tally })
    }
    return seconds
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isString(value: unknown): value is string {
    return typeof value === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
