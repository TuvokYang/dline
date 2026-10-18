import fs from "node:fs/promises"
import path from "node:path"
import { writeFileAtomic, writeJsonAtomic } from "@shared/storage/atomic-file"
import { parseUsageObservation } from "@/services/telemetry/remote/usage/usageCatalog"
import {
    emptyUsageOutbox,
    sha256Hex,
    type UsageInflight,
    type UsageOutboxState,
} from "@/services/telemetry/remote/usage/usageOutbox"
import type { UsageWindow } from "@/services/telemetry/remote/usage/usageWindow"
import { FileLock } from "../backend/jsonl/FileLock"
import type { OtelStorageLayout } from "./OtelStorageLayout"
import { quarantineDocument } from "./quarantine"

export const USAGE_OUTBOX_SCHEMA_VERSION = 1
/** How long a sender owns delivery without renewing; longer than one HTTP attempt, short enough to take over a dead window. */
export const USAGE_SENDER_LEASE_MS = 90_000
/** Renew once less than this share of the lease is left; a cycle then always starts with over half a lease. */
const LEASE_RENEW_FRACTION = 2 / 3
const LOCK_ACQUIRE_ATTEMPTS = 50
const BODY_SUFFIX = ".bin"
const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f-]{27,55}$/i

/** Proof of the sender lease; every change to the outbox must present the current one. */
export interface UsageSenderGrant {
    readonly ownerId: string
    readonly generation: number
}

interface SenderLease extends UsageSenderGrant {
    readonly expiresAt: number
}

interface OutboxDocument {
    /** Highest lease generation ever granted; it only rises, so an old owner can never match again. */
    readonly generation: number
    readonly lease?: SenderLease
    readonly state: UsageOutboxState
}

type LatestOutbox =
    | { readonly status: "valid"; readonly document: OutboxDocument }
    | { readonly status: "missing" }
    | { readonly status: "unsupported" }

export type UsageOutboxCommit<T> = { readonly status: "committed"; readonly result: T } | { readonly status: "fenced" }

export interface UsageOutboxRepositoryOptions {
    readonly clock?: () => number
    readonly leaseMs?: number
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
 */
export class UsageOutboxRepository {
    private readonly lock = new FileLock({ maxAcquireAttempts: LOCK_ACQUIRE_ATTEMPTS })
    private readonly clock: () => number
    private readonly leaseMs: number

    constructor(
        private readonly layout: OtelStorageLayout,
        options: UsageOutboxRepositoryOptions = {},
    ) {
        this.clock = options.clock ?? Date.now
        this.leaseMs = options.leaseMs ?? USAGE_SENDER_LEASE_MS
    }

    /**
     * Take or renew the sender lease. A live lease of another owner wins; an
     * expired one is taken over under a new generation.
     */
    async claim(ownerId: string): Promise<UsageSenderGrant | undefined> {
        return this.mutate((document, now) => {
            const lease = document.lease
            if (lease && lease.expiresAt > now && lease.ownerId !== ownerId) return { result: undefined }
            const renewing = lease !== undefined && lease.ownerId === ownerId && lease.expiresAt > now
            // A lease with most of its time left is kept as it is, so a quiet machine does not rewrite the outbox every cycle.
            if (renewing && lease.expiresAt - now > this.leaseMs * LEASE_RENEW_FRACTION) {
                return { result: { ownerId, generation: lease.generation } }
            }
            const generation = renewing ? lease.generation : document.generation + 1
            const next: SenderLease = { ownerId, generation, expiresAt: now + this.leaseMs }
            return { document: { ...document, generation, lease: next }, result: { ownerId, generation } }
        })
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
            const previous = latest.status === "valid" ? latest.document : { generation: 0, state: emptyUsageOutbox(0) }
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
        await quarantineDocument(this.layout.usageOutboxPath, this.layout.remoteQuarantineDir, this.clock())
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
    return {
        schema_version: USAGE_OUTBOX_SCHEMA_VERSION,
        generation: document.generation,
        ...(document.lease
            ? {
                  lease: {
                      owner_id: document.lease.ownerId,
                      generation: document.lease.generation,
                      expires_at: document.lease.expiresAt,
                  },
              }
            : {}),
        state: {
            policy_epoch: state.policyEpoch,
            next_eligible_at: state.nextEligibleAt,
            sealed_through: state.sealedThrough,
            dropped_windows: state.droppedWindows,
            windows: state.windows.map(serializeWindow),
            folded_shards: state.foldedShards,
            ...(state.inflight
                ? {
                      inflight: {
                          request_id: state.inflight.requestId,
                          body_sha256: state.inflight.bodySha256,
                          windows: state.inflight.windows.map(serializeWindow),
                          dropped_windows: state.inflight.droppedWindows,
                          created_at: state.inflight.createdAt,
                          attempts: state.inflight.attempts,
                          not_before: state.inflight.notBefore,
                      },
                  }
                : {}),
        },
    }
}

function serializeWindow(window: UsageWindow): Record<string, unknown> {
    return { started_at: window.startedAt, counters: window.counters, measurements: window.measurements }
}

function parseDocument(value: unknown): LatestOutbox | { readonly status: "malformed" } {
    if (!isRecord(value)) return { status: "malformed" }
    const schemaVersion = value.schema_version
    if (!isCount(schemaVersion) || schemaVersion < 1) return { status: "malformed" }
    if (schemaVersion > USAGE_OUTBOX_SCHEMA_VERSION) return { status: "unsupported" }
    if (!isCount(value.generation)) return { status: "malformed" }
    let lease: SenderLease | undefined
    if (value.lease !== undefined) {
        lease = parseLease(value.lease)
        if (!lease || lease.generation > value.generation) return { status: "malformed" }
    }
    const state = parseState(value.state)
    if (!state) return { status: "malformed" }
    return { status: "valid", document: { generation: value.generation, ...(lease ? { lease } : {}), state } }
}

function parseLease(value: unknown): SenderLease | undefined {
    if (!isRecord(value) || typeof value.owner_id !== "string" || value.owner_id.length === 0) return undefined
    if (!isCount(value.generation) || value.generation < 1 || !isCount(value.expires_at)) return undefined
    return { ownerId: value.owner_id, generation: value.generation, expiresAt: value.expires_at }
}

function parseState(value: unknown): UsageOutboxState | undefined {
    if (!isRecord(value)) return undefined
    const { policy_epoch: policyEpoch, next_eligible_at: nextEligibleAt, sealed_through: sealedThrough } = value
    if (!isCount(policyEpoch) || !isCount(nextEligibleAt) || !isCount(sealedThrough) || !isCount(value.dropped_windows)) {
        return undefined
    }
    const windows = parseWindows(value.windows)
    const foldedShards = value.folded_shards
    if (!windows || !Array.isArray(foldedShards) || !foldedShards.every((name) => typeof name === "string")) return undefined
    let inflight: UsageInflight | undefined
    if (value.inflight !== undefined) {
        inflight = parseInflight(value.inflight)
        if (!inflight) return undefined
    }
    return {
        policyEpoch,
        nextEligibleAt,
        sealedThrough,
        droppedWindows: value.dropped_windows,
        windows,
        foldedShards: foldedShards as string[],
        ...(inflight ? { inflight } : {}),
    }
}

function parseInflight(value: unknown): UsageInflight | undefined {
    if (!isRecord(value)) return undefined
    const { request_id: requestId, body_sha256: bodySha256, created_at: createdAt, not_before: notBefore } = value
    if (typeof requestId !== "string" || !REQUEST_ID_PATTERN.test(requestId)) return undefined
    if (typeof bodySha256 !== "string" || !/^[0-9a-f]{64}$/.test(bodySha256)) return undefined
    const windows = parseWindows(value.windows)
    if (!windows || !isCount(value.dropped_windows) || !isCount(createdAt) || !isCount(value.attempts) || !isCount(notBefore)) {
        return undefined
    }
    return {
        requestId,
        bodySha256,
        windows,
        droppedWindows: value.dropped_windows,
        createdAt,
        attempts: value.attempts,
        notBefore,
    }
}

function parseWindows(value: unknown): UsageWindow[] | undefined {
    if (!Array.isArray(value)) return undefined
    const windows: UsageWindow[] = []
    for (const entry of value) {
        if (!isRecord(entry) || !isCount(entry.started_at)) return undefined
        const observation = parseUsageObservation(entry)
        if (!observation) return undefined
        windows.push({ startedAt: entry.started_at, ...observation })
    }
    return windows
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
