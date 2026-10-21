import fs from "node:fs/promises"
import path from "node:path"
import { writeFileAtomic, writeJsonAtomic } from "@shared/storage/atomic-file"
import { type ChannelPacing, INITIAL_PACING } from "@/services/telemetry/remote/contracts/pacing"
import type { UsageMinute } from "@/services/telemetry/remote/usage/usageBatch"
import {
    emptyUsageOutbox,
    sha256Hex,
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
 * Version 2 holds v2 tallies and the channel pacing; version 1 held the dotted v1 catalog.
 * `lease.granted_at` and `waiting` are optional additions inside version 2: a build
 * that predates turns ignores them and drops them when it rewrites the document.
 */
export const USAGE_OUTBOX_SCHEMA_VERSION = 2
const LEGACY_SCHEMA_VERSION = 1
/** How long a sender owns delivery without renewing; longer than one HTTP attempt, short enough to take over a dead window. */
export const USAGE_SENDER_LEASE_MS = 90_000
const LOCK_ACQUIRE_ATTEMPTS = 50
const BODY_SUFFIX = ".bin"
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,55}$/i

interface OutboxDocument extends SenderTurns {
    readonly state: UsageOutboxState
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
    async reset(policyEpoch: number): Promise<void> {
        const owned = await this.mutate((document) => ({
            document: { ...document, state: emptyUsageOutbox(policyEpoch, document.state) },
            result: true,
        }))
        if (owned) await this.removeBodies()
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
            dropped_minutes: state.droppedMinutes,
            minutes: state.minutes.map(serializeMinute),
            folded_shards: state.foldedShards,
            ...(state.inflight
                ? {
                      inflight: {
                          request_id: state.inflight.requestId,
                          body_sha256: state.inflight.bodySha256,
                          minutes: state.inflight.minutes.map(serializeMinute),
                          dropped_minutes: state.inflight.droppedMinutes,
                          created_at: state.inflight.createdAt,
                          attempts: state.inflight.attempts,
                          not_before: state.inflight.notBefore,
                      },
                  }
                : {}),
        },
    }
}

function serializeMinute(minute: UsageMinute): Record<string, unknown> {
    return { started_at: minute.startedAt, tally: minute.tally }
}

function parseDocument(value: unknown): LatestOutbox | { readonly status: "malformed" } {
    if (!isRecord(value)) return { status: "malformed" }
    const schemaVersion = value.schema_version
    if (!isCount(schemaVersion) || schemaVersion < LEGACY_SCHEMA_VERSION) return { status: "malformed" }
    if (schemaVersion > USAGE_OUTBOX_SCHEMA_VERSION) return { status: "unsupported" }
    if (!isCount(value.generation)) return { status: "malformed" }
    let lease: SenderLease | undefined
    if (value.lease !== undefined) {
        lease = parseLease(value.lease)
        if (!lease || lease.generation > value.generation) return { status: "malformed" }
    }
    const state = schemaVersion === LEGACY_SCHEMA_VERSION ? parseLegacyState(value.state) : parseState(value.state)
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

/**
 * Carry a v1 outbox forward. Its minutes use the dotted v1 catalog, which a v2
 * body cannot hold, so they are dropped and counted; the lease, the server gate
 * and the folded shard names survive, so the upgrade neither resends nor
 * double-counts. The inflight body left beside it is removed by the next cycle.
 */
function parseLegacyState(value: unknown): UsageOutboxState | undefined {
    if (!isRecord(value)) return undefined
    const { policy_epoch: policyEpoch, next_eligible_at: nextEligibleAt, sealed_through: sealedThrough } = value
    if (!isCount(policyEpoch) || !isCount(nextEligibleAt) || !isCount(sealedThrough)) return undefined
    const foldedShards = Array.isArray(value.folded_shards) ? value.folded_shards.filter(isString) : []
    const inflight = isRecord(value.inflight) ? value.inflight : undefined
    const lost =
        (isCount(value.dropped_windows) ? value.dropped_windows : 0) +
        (Array.isArray(value.windows) ? value.windows.length : 0) +
        (inflight && Array.isArray(inflight.windows) ? inflight.windows.length : 0) +
        (inflight && isCount(inflight.dropped_windows) ? inflight.dropped_windows : 0)
    return {
        ...emptyUsageOutbox(policyEpoch, { pacing: { ...INITIAL_PACING, nextEligibleAt }, foldedShards }),
        sealedThrough,
        droppedMinutes: lost,
    }
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
    const { policy_epoch: policyEpoch, sealed_through: sealedThrough, dropped_minutes: droppedMinutes } = value
    if (!isCount(policyEpoch) || !isCount(sealedThrough) || !isCount(droppedMinutes)) return undefined
    const pacing = parsePacing(value.pacing)
    const minutes = parseMinutes(value.minutes)
    const foldedShards = value.folded_shards
    if (!pacing || !minutes || !Array.isArray(foldedShards) || !foldedShards.every(isString)) return undefined
    let inflight: UsageInflight | undefined
    if (value.inflight !== undefined) {
        inflight = parseInflight(value.inflight)
        if (!inflight) return undefined
    }
    return {
        policyEpoch,
        pacing,
        sealedThrough,
        droppedMinutes,
        minutes,
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
    const minutes = parseMinutes(value.minutes)
    if (!minutes || !isCount(value.dropped_minutes) || !isCount(createdAt) || !isCount(value.attempts) || !isCount(notBefore)) {
        return undefined
    }
    return {
        requestId,
        bodySha256,
        minutes,
        droppedMinutes: value.dropped_minutes,
        createdAt,
        attempts: value.attempts,
        notBefore,
    }
}

function parseMinutes(value: unknown): UsageMinute[] | undefined {
    if (!Array.isArray(value)) return undefined
    const minutes: UsageMinute[] = []
    for (const entry of value) {
        if (!isRecord(entry) || !isCount(entry.started_at)) return undefined
        const tally = parseUsageTally(entry.tally)
        if (!tally) return undefined
        minutes.push({ startedAt: entry.started_at, tally })
    }
    return minutes
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
