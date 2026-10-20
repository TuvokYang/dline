import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { backupPathOf, readJsonWithBackup, writeJsonAtomic } from "@shared/storage/atomic-file"
import {
    afterAcknowledged,
    afterRateLimited,
    type ChannelPacing,
    isWaiting,
    mayStartBatch,
    replayBudgetExhausted,
    replayDelayMs,
    reserveInterval,
} from "@/services/telemetry/remote/contracts/pacing"
import { aggregateDiagnostics, type DiagnosticRecord } from "@/services/telemetry/remote/diagnostics/diagnosticRecord"
import { FileLock } from "../backend/jsonl/FileLock"

/** Aggregated records one device may create per UTC hour and per UTC day (otel contract v2 §3.3). */
export const DIAGNOSTICS_PER_HOUR = 50
export const DIAGNOSTICS_PER_DAY = 200
/** Records kept while the service cannot be reached or asks to wait; more are dropped and counted. */
export const MAX_PENDING_DIAGNOSTICS = 1_000
/** At most this many records travel in one request, within {@link MAX_DIAGNOSTICS_REQUEST_BYTES}. */
export const MAX_DIAGNOSTICS_PER_REQUEST = 100
export const MAX_DIAGNOSTICS_REQUEST_BYTES = 128 * 1024
/** How long one window may hold a batch before another may send it instead. */
export const DIAGNOSTICS_CLAIM_TTL_MS = 60_000
/** A stop the service asked for is retried after this long, never sooner. */
export const DIAGNOSTICS_STOP_RETRY_MS = 30 * 60_000
const HOUR_MS = 60 * 60_000
const DAY_MS = 24 * HOUR_MS
const SCHEMA_VERSION = 2

/** Encodes records and the count dropped since the previous request into one `/v1/logs` body. */
export type DiagnosticEncoder = (records: readonly DiagnosticRecord[], droppedRecords: number) => string

/** A batch this window sends now; the same id and bytes are sent again until it settles. */
export interface ClaimedDiagnostics {
    readonly requestId: string
    readonly body: string
}

/** How the service answered a claimed batch, as the delivery worker read it. */
export type DiagnosticSettlement =
    | { readonly kind: "acknowledged"; readonly nextEligibleAt?: number }
    /** The service may hold the batch: the same bytes follow after a backoff. */
    | { readonly kind: "replay"; readonly retryAfterMs?: number }
    /** A 429 or a pause: the channel sends nothing until the wait ends, then replays the same batch first. */
    | { readonly kind: "wait"; readonly retryAfterMs?: number }
    /** 413: the first half is resent at once under a new id, the rest rejoins the pending records. */
    | { readonly kind: "split" }
    /** The service will never accept the batch. */
    | { readonly kind: "discard" }
    /** No token yet; the batch waits unchanged and the attempt does not count. */
    | { readonly kind: "retry"; readonly at: number }
    | { readonly kind: "stopped"; readonly code: string }

interface Inflight {
    readonly request_id: string
    readonly body: string
    readonly records: DiagnosticRecord[]
    /** Dropped records this body reports; restored when the body is not delivered. */
    readonly dropped: number
    readonly created_at: number
    readonly attempts: number
    readonly not_before: number
}

interface Quota {
    readonly hour_start: number
    readonly hour_count: number
    readonly day_start: number
    readonly day_count: number
}

interface OutboxDocument {
    readonly schema_version: typeof SCHEMA_VERSION
    readonly records: DiagnosticRecord[]
    /** Records discarded locally since the last delivered request, reported as `dline.dropped_records`. */
    readonly dropped: number
    readonly quota: Quota
    readonly pacing: { readonly next_eligible_at: number; readonly wait_until: number; readonly consecutive_waits: number }
    readonly inflight?: Inflight
    readonly claim?: { readonly owner: string; readonly until: number }
    readonly stop?: { readonly code: string; readonly stopped_at: number }
}

const EMPTY: OutboxDocument = {
    schema_version: SCHEMA_VERSION,
    records: [],
    dropped: 0,
    quota: { hour_start: 0, hour_count: 0, day_start: 0, day_count: 0 },
    pacing: { next_eligible_at: 0, wait_until: 0, consecutive_waits: 0 },
}

export interface DiagnosticOutboxRepositoryOptions {
    readonly encode: DiagnosticEncoder
    /** Source of the 429 wait jitter. */
    readonly random?: () => number
}

/**
 * The machine-wide queue of diagnostic records waiting for `/v1/logs`.
 *
 * Every window appends to it and any one window sends from it, under one file
 * lock. Records with the same key merge while they wait, and the device limits
 * apply when a new key arrives. A batch, once built, keeps its request id and
 * exact bytes until the service settles it, so a replay after a timeout or a
 * crash is recognised as a duplicate rather than stored twice. The channel's
 * server gate and 429 wait live here too, so they hold across windows and restarts.
 */
export class DiagnosticOutboxRepository {
    private readonly lock = new FileLock()

    constructor(
        private readonly filePath: string,
        private readonly options: DiagnosticOutboxRepositoryOptions,
    ) {}

    /**
     * Merge records into the pending ones; a new key beyond the device limits or
     * the backlog bound is dropped and counted. `droppedBeforehand` counts records
     * the caller already had to discard, so they are reported too.
     */
    async append(records: readonly DiagnosticRecord[], now: number, droppedBeforehand = 0): Promise<void> {
        if (records.length === 0 && droppedBeforehand === 0) return
        await this.mutate((current) => {
            let quota = rollQuota(current.quota, now)
            let pending = current.records.length
            const admit = () => {
                if (quota.hour_count >= DIAGNOSTICS_PER_HOUR || quota.day_count >= DIAGNOSTICS_PER_DAY) return false
                if (pending >= MAX_PENDING_DIAGNOSTICS) return false
                quota = { ...quota, hour_count: quota.hour_count + 1, day_count: quota.day_count + 1 }
                pending++
                return true
            }
            const merged = aggregateDiagnostics(current.records, records, admit)
            return { ...current, records: merged.records, quota, dropped: current.dropped + merged.refused + droppedBeforehand }
        })
    }

    /**
     * Take the batch to send now, or undefined when another window holds it, a
     * wait or the server gate holds the channel, nothing is due, or the service said stop.
     */
    async claim(owner: string, now: number): Promise<ClaimedDiagnostics | undefined> {
        let claimed: ClaimedDiagnostics | undefined
        await this.mutate((current) => {
            let next = current
            if (next.stop) {
                // A stop recorded in the future means the clock moved back; it expires like a past one.
                const age = now - next.stop.stopped_at
                if (age >= 0 && age < DIAGNOSTICS_STOP_RETRY_MS) return current
                next = withoutStop(next)
            }
            if (next.claim && next.claim.owner !== owner && next.claim.until > now) return current
            const pacing = pacingOf(next)
            if (isWaiting(pacing, now)) return current
            let inflight = next.inflight
            let records = next.records
            let dropped = next.dropped
            let nextPacing = pacing
            if (inflight) {
                if (now < inflight.not_before) return current
            } else {
                if (records.length === 0 || !mayStartBatch(pacing, now)) return current
                inflight = this.buildInflight(records, dropped, now)
                records = records.slice(inflight.records.length)
                dropped = 0
                nextPacing = reserveInterval(pacing, "logs", now)
            }
            claimed = { requestId: inflight.request_id, body: inflight.body }
            return {
                ...next,
                records,
                dropped,
                inflight,
                pacing: storedPacing(nextPacing),
                claim: { owner, until: now + DIAGNOSTICS_CLAIM_TTL_MS },
            }
        })
        return claimed
    }

    /** Record how the service answered the batch this window claimed. */
    async settle(owner: string, requestId: string, settlement: DiagnosticSettlement, now: number): Promise<void> {
        await this.mutate((current) => {
            const inflight = current.inflight
            if (inflight?.request_id !== requestId) return current
            const released = current.claim?.owner === owner ? withoutClaim(current) : current
            const rest = withoutInflight(released)
            const lost = (document: OutboxDocument) => ({
                ...document,
                dropped: document.dropped + inflight.dropped + inflight.records.length,
            })
            switch (settlement.kind) {
                case "acknowledged":
                    return {
                        ...rest,
                        pacing: storedPacing(afterAcknowledged(pacingOf(rest), "logs", settlement.nextEligibleAt, now)),
                    }
                case "replay": {
                    const attempts = inflight.attempts + 1
                    if (replayBudgetExhausted(attempts, inflight.created_at, now)) return lost(rest)
                    const notBefore = now + replayDelayMs(attempts, settlement.retryAfterMs)
                    return { ...released, inflight: { ...inflight, attempts, not_before: notBefore } }
                }
                case "wait": {
                    // §1.7 rule 7: the batch stays as it is and is replayed first once the wait
                    // ends, so a copy an earlier timed-out attempt stored is answered as a duplicate.
                    // The wait does not count against the 24-hour replay age (rule 8).
                    const pacing = afterRateLimited(pacingOf(rest), settlement.retryAfterMs, now, this.options.random)
                    const waitedMs = Math.max(0, pacing.waitUntil - now)
                    return {
                        ...released,
                        inflight: { ...inflight, created_at: inflight.created_at + waitedMs, not_before: pacing.waitUntil },
                        pacing: storedPacing(pacing),
                    }
                }
                case "split": {
                    if (inflight.records.length <= 1) return lost(rest)
                    const half = Math.ceil(inflight.records.length / 2)
                    const restored = this.restore(rest, inflight.records.slice(half), 0)
                    const first = this.buildInflight(inflight.records.slice(0, half), inflight.dropped, now)
                    return { ...restored, inflight: first }
                }
                case "discard":
                    return lost(rest)
                case "retry":
                    return { ...released, inflight: { ...inflight, not_before: settlement.at } }
                case "stopped":
                    return { ...released, stop: { code: settlement.code, stopped_at: now } }
            }
        })
    }

    /**
     * Forget every queued record, for when error reporting is turned off. The
     * device limits, a running wait or pause, the server gate and a stop are
     * not data about the user: they stay, so turning reporting off and on
     * again cannot send early or reset the hourly and daily counts.
     */
    async clear(): Promise<void> {
        await mkdir(path.dirname(this.filePath), { recursive: true })
        await this.lock.withLock(this.filePath, async () => {
            const stored = await this.load()
            if (stored?.kind === "current") {
                const { quota, pacing, stop } = stored.document
                await writeJsonAtomic(this.filePath, { ...EMPTY, quota, pacing, ...(stop ? { stop } : {}) }, { fsync: true })
                await rm(backupPathOf(this.filePath), { force: true })
                return
            }
            // A document this build cannot rewrite still holds records; deleting it is the only way to forget them.
            await Promise.all([rm(this.filePath, { force: true }), rm(backupPathOf(this.filePath), { force: true })])
        })
    }

    /** The current document; empty when there is none, it is unreadable, or a newer build owns it. */
    async read(): Promise<OutboxDocument> {
        const stored = await this.load()
        return stored?.kind === "current" ? stored.document : EMPTY
    }

    private async load(): Promise<StoredOutbox | undefined> {
        const result = await readJsonWithBackup(this.filePath, parseOutbox)
        return result.status === "primary" || result.status === "backup" ? result.value : undefined
    }

    /** The most leading records that fit one request, at least one, encoded with the drops they report. */
    private buildInflight(records: readonly DiagnosticRecord[], dropped: number, now: number): Inflight {
        let count = Math.min(records.length, MAX_DIAGNOSTICS_PER_REQUEST)
        let body = this.options.encode(records.slice(0, count), dropped)
        while (count > 1 && Buffer.byteLength(body, "utf8") > MAX_DIAGNOSTICS_REQUEST_BYTES) {
            count = Math.max(1, Math.floor(count / 2))
            body = this.options.encode(records.slice(0, count), dropped)
        }
        return {
            request_id: randomUUID(),
            body,
            records: records.slice(0, count),
            dropped,
            created_at: now,
            attempts: 0,
            not_before: now,
        }
    }

    /** Put records of an undelivered batch back ahead of the pending ones, merging equal keys. */
    private restore(document: OutboxDocument, records: readonly DiagnosticRecord[], dropped: number): OutboxDocument {
        const merged = aggregateDiagnostics(records, document.records).records
        const kept = merged.slice(0, MAX_PENDING_DIAGNOSTICS)
        return {
            ...document,
            records: kept,
            dropped: document.dropped + dropped + (merged.length - kept.length),
        }
    }

    /** Apply a change under the lock; a document written by a newer build is left alone. */
    private async mutate(change: (current: OutboxDocument) => OutboxDocument): Promise<void> {
        await mkdir(path.dirname(this.filePath), { recursive: true })
        await this.lock.withLock(this.filePath, async () => {
            const stored = await this.load()
            if (stored?.kind === "newer") return
            const current = stored?.document ?? EMPTY
            const next = change(current)
            if (next !== current) await writeJsonAtomic(this.filePath, next, { fsync: true })
        })
    }
}

/** Start a new hour or day count once the UTC hour or day changed. */
function rollQuota(quota: Quota, now: number): Quota {
    const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS
    const dayStart = Math.floor(now / DAY_MS) * DAY_MS
    return {
        hour_start: hourStart,
        hour_count: quota.hour_start === hourStart ? quota.hour_count : 0,
        day_start: dayStart,
        day_count: quota.day_start === dayStart ? quota.day_count : 0,
    }
}

function pacingOf(document: OutboxDocument): ChannelPacing {
    const { pacing } = document
    return { nextEligibleAt: pacing.next_eligible_at, waitUntil: pacing.wait_until, consecutiveWaits: pacing.consecutive_waits }
}

function storedPacing(pacing: ChannelPacing): OutboxDocument["pacing"] {
    return { next_eligible_at: pacing.nextEligibleAt, wait_until: pacing.waitUntil, consecutive_waits: pacing.consecutiveWaits }
}

function withoutStop({ stop: _stop, ...rest }: OutboxDocument): OutboxDocument {
    return rest
}

function withoutClaim({ claim: _claim, ...rest }: OutboxDocument): OutboxDocument {
    return rest
}

function withoutInflight({ inflight: _inflight, ...rest }: OutboxDocument): OutboxDocument {
    return rest
}

/** A document this build owns, or one a newer build wrote, which is read as empty and never rewritten. */
type StoredOutbox = { readonly kind: "current"; readonly document: OutboxDocument } | { readonly kind: "newer" }

/**
 * Throws for anything that is not a complete outbox document, as
 * `readJsonWithBackup` requires, so a damaged batch cannot wedge every later
 * settle. The v1 queue lived in another file and is never read here.
 */
function parseOutbox(value: unknown): StoredOutbox {
    if (!isRecord(value) || !isCount(value.schema_version)) throw new Error("Not a diagnostic outbox document")
    if (value.schema_version > SCHEMA_VERSION) return { kind: "newer" }
    const valid =
        value.schema_version === SCHEMA_VERSION &&
        Array.isArray(value.records) &&
        value.records.every(isDiagnosticRecord) &&
        isCount(value.dropped) &&
        isQuota(value.quota) &&
        isPacing(value.pacing) &&
        (value.inflight === undefined || isInflight(value.inflight)) &&
        (value.claim === undefined || isClaim(value.claim)) &&
        (value.stop === undefined || isStop(value.stop))
    if (!valid) throw new Error("Not a diagnostic outbox document")
    return { kind: "current", document: value as unknown as OutboxDocument }
}

function isDiagnosticRecord(value: unknown): value is DiagnosticRecord {
    return (
        isRecord(value) &&
        typeof value.name === "string" &&
        (value.channel === "error" || value.channel === "runtime") &&
        typeof value.severity === "string" &&
        isCount(value.firstSeenMs) &&
        isCount(value.lastSeenMs) &&
        isCount(value.occurrences) &&
        value.occurrences >= 1 &&
        isRecord(value.attributes)
    )
}

function isInflight(value: unknown): value is Inflight {
    return (
        isRecord(value) &&
        typeof value.request_id === "string" &&
        typeof value.body === "string" &&
        Array.isArray(value.records) &&
        value.records.every(isDiagnosticRecord) &&
        isCount(value.dropped) &&
        isCount(value.created_at) &&
        isCount(value.attempts) &&
        isCount(value.not_before)
    )
}

function isQuota(value: unknown): value is Quota {
    return (
        isRecord(value) &&
        isCount(value.hour_start) &&
        isCount(value.hour_count) &&
        isCount(value.day_start) &&
        isCount(value.day_count)
    )
}

function isPacing(value: unknown): value is OutboxDocument["pacing"] {
    return isRecord(value) && isCount(value.next_eligible_at) && isCount(value.wait_until) && isCount(value.consecutive_waits)
}

function isClaim(value: unknown): value is OutboxDocument["claim"] {
    return isRecord(value) && typeof value.owner === "string" && isCount(value.until)
}

function isStop(value: unknown): value is OutboxDocument["stop"] {
    return isRecord(value) && typeof value.code === "string" && isCount(value.stopped_at)
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
