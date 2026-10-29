import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { backupPathOf, readJsonWithBackup, writeJsonAtomic } from "@shared/storage/atomic-file"
import {
    afterAcknowledged,
    afterRateLimited,
    isWaiting,
    mayStartBatch,
    replayBudgetExhausted,
    replayDelayMs,
    reserveInterval,
} from "@/services/telemetry/remote/contracts/pacing"
import { aggregateDiagnostics, type DiagnosticRecord } from "@/services/telemetry/remote/diagnostics/diagnosticRecord"
import { FileLock } from "../backend/jsonl/FileLock"
import {
    countAdmitted,
    EMPTY_PACING,
    EMPTY_QUOTA,
    isStoredPacing,
    isStoredQuota,
    pacingOf,
    rollQuota,
    type StoredPacing,
    type StoredQuota,
    storedPacing,
} from "./OutboxGates"
import { discardDocument } from "./quarantine"

/** Aggregated records one device may create per UTC hour and per UTC day (otel contract v2.1 §3.3). */
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
/**
 * 3: contract 5 Resource, Scope and model projection. A version 2 document holds
 * records and an inflight body encoded under the earlier contract; it is
 * discarded with loss evidence, never replayed or migrated.
 */
const SCHEMA_VERSION = 3
/** Label of this document in loss evidence. */
const EVIDENCE_DOCUMENT = "diagnostics-outbox"

/** Encodes records and the count dropped since the previous request into one `/logs` body. */
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

interface OutboxDocument {
    readonly schema_version: typeof SCHEMA_VERSION
    readonly records: DiagnosticRecord[]
    /** Records discarded locally since the last delivered request, reported as `dline.dropped_records`. */
    readonly dropped: number
    readonly quota: StoredQuota
    readonly pacing: StoredPacing
    readonly inflight?: Inflight
    readonly claim?: { readonly owner: string; readonly until: number }
    readonly stop?: { readonly code: string; readonly stopped_at: number }
}

const EMPTY: OutboxDocument = {
    schema_version: SCHEMA_VERSION,
    records: [],
    dropped: 0,
    quota: EMPTY_QUOTA,
    pacing: EMPTY_PACING,
}

export interface DiagnosticOutboxRepositoryOptions {
    readonly encode: DiagnosticEncoder
    /** Where loss evidence of a discarded older document is written. */
    readonly quarantineDir: string
    /** Source of the 429 wait jitter. */
    readonly random?: () => number
}

/**
 * The machine-wide queue of diagnostic records waiting for `/logs`.
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
                quota = countAdmitted(quota)
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
            const pacing = pacingOf(next.pacing)
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
                        pacing: storedPacing(afterAcknowledged(pacingOf(rest.pacing), "logs", settlement.nextEligibleAt, now)),
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
                    const pacing = afterRateLimited(pacingOf(rest.pacing), settlement.retryAfterMs, now, this.options.random)
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

    /** The current document; empty when there is none, it is unreadable, older, or a newer build owns it. */
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

    /** Apply a change under the lock; a document written by a newer build is left alone, and `false` says so. */
    private async mutate(change: (current: OutboxDocument) => OutboxDocument): Promise<boolean> {
        await mkdir(path.dirname(this.filePath), { recursive: true })
        return this.lock.withLock(this.filePath, async () => {
            const stored = await this.load()
            if (stored?.kind === "newer") return false
            if (stored?.kind === "older") await this.discardOlder(stored)
            const current = stored?.kind === "current" ? stored.document : EMPTY
            const next = change(current)
            if (next !== current) await writeJsonAtomic(this.filePath, next, { fsync: true })
            return true
        })
    }

    /** Drop a document an earlier contract wrote, leaving only how much it held. */
    private async discardOlder(stored: OlderOutbox): Promise<void> {
        await discardDocument(
            this.filePath,
            this.options.quarantineDir,
            {
                document: EVIDENCE_DOCUMENT,
                reason: "older_schema",
                schemaVersion: stored.schemaVersion,
                counts: { records: stored.records, dropped: stored.dropped },
            },
            Date.now(),
        )
    }
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

/** What an earlier contract's document held, as far as loss evidence needs it. */
interface OlderOutbox {
    readonly kind: "older"
    readonly schemaVersion: number
    readonly records: number
    readonly dropped: number
}

/**
 * A document this build owns; one a newer build wrote, which is read as empty
 * and never rewritten; or one an earlier contract wrote, which the next write
 * discards with loss evidence.
 */
type StoredOutbox = { readonly kind: "current"; readonly document: OutboxDocument } | { readonly kind: "newer" } | OlderOutbox

/**
 * Throws for anything that is not a complete outbox document, as
 * `readJsonWithBackup` requires, so a damaged batch cannot wedge every later
 * settle.
 */
function parseOutbox(value: unknown): StoredOutbox {
    if (!isRecord(value) || !isCount(value.schema_version)) throw new Error("Not a diagnostic outbox document")
    if (value.schema_version > SCHEMA_VERSION) return { kind: "newer" }
    if (value.schema_version < SCHEMA_VERSION) return olderOutbox(value, value.schema_version)
    const valid =
        value.schema_version === SCHEMA_VERSION &&
        Array.isArray(value.records) &&
        value.records.every(isDiagnosticRecord) &&
        isCount(value.dropped) &&
        isStoredQuota(value.quota) &&
        isStoredPacing(value.pacing) &&
        (value.inflight === undefined || isInflight(value.inflight)) &&
        (value.claim === undefined || isClaim(value.claim)) &&
        (value.stop === undefined || isStop(value.stop))
    if (!valid) throw new Error("Not a diagnostic outbox document")
    return { kind: "current", document: value as unknown as OutboxDocument }
}

function olderOutbox(value: Record<string, unknown>, schemaVersion: number): OlderOutbox {
    const length = (candidate: unknown) => (Array.isArray(candidate) ? candidate.length : 0)
    const inflight = isRecord(value.inflight) ? value.inflight : undefined
    const count = (candidate: unknown) => (isCount(candidate) ? candidate : 0)
    return {
        kind: "older",
        schemaVersion,
        records: length(value.records) + length(inflight?.records),
        dropped: count(value.dropped) + count(inflight?.dropped),
    }
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
