import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { backupPathOf, readJsonWithBackup, writeJsonAtomic } from "@shared/storage/atomic-file"
import { OTLP_LIMITS } from "@/services/telemetry/remote/contracts/otlpProduction"
import {
    afterAcknowledged,
    afterRateLimited,
    isWaiting,
    mayStartBatch,
    replayBudgetExhausted,
    replayDelayMs,
    reserveInterval,
} from "@/services/telemetry/remote/contracts/pacing"
import { FileLock } from "../backend/jsonl/FileLock"
import type { ClaimedDiagnostics, DiagnosticSettlement } from "./DiagnosticOutboxRepository"
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

/** How long one window may hold a batch before another may send it instead. */
export const OTLP_BATCH_CLAIM_TTL_MS = 60_000
/** A stop the service asked for is retried after this long, never sooner. */
export const OTLP_BATCH_STOP_RETRY_MS = 30 * 60_000
const SCHEMA_VERSION = 1

export type OtlpBatchChannel = "metrics" | "traces"

export interface OtlpBatchOutboxOptions<TItem> {
    readonly channel: OtlpBatchChannel
    /** Encodes the leading items of one request and the records dropped since the previous one. */
    readonly encode: (items: readonly TItem[], droppedRecords: number) => string
    /** Validates one stored item; a document holding anything else is unreadable and replaced. */
    readonly isItem: (value: unknown) => value is TItem
    readonly maxItemsPerRequest: number
    /** Items kept while the service cannot be reached or asks to wait; more are dropped and counted. */
    readonly maxPendingItems: number
    /** Device admission per UTC hour and day (TADR §2.4); without it only the backlog bound applies. */
    readonly admission?: { readonly perHour: number; readonly perDay: number }
    /** Source of the 429 wait jitter. */
    readonly random?: () => number
}

interface Inflight<TItem> {
    readonly request_id: string
    readonly body: string
    readonly items: TItem[]
    /** Dropped records this body reports; restored when the body is not delivered. */
    readonly dropped: number
    readonly created_at: number
    readonly attempts: number
    readonly not_before: number
}

interface OutboxDocument<TItem> {
    readonly schema_version: typeof SCHEMA_VERSION
    readonly items: TItem[]
    /** Items discarded locally since the last delivered request, reported as `dline.dropped_records`. */
    readonly dropped: number
    readonly quota: StoredQuota
    readonly pacing: StoredPacing
    readonly inflight?: Inflight<TItem>
    readonly claim?: { readonly owner: string; readonly until: number }
    readonly stop?: { readonly code: string; readonly stopped_at: number }
}

type StoredOutbox<TItem> = { readonly kind: "current"; readonly document: OutboxDocument<TItem> } | { readonly kind: "newer" }

/**
 * The machine-wide queue of one production OTLP signal, Metrics or Traces
 * (TADR §2.4).
 *
 * Every window appends to it and any one window sends from it, under one file
 * lock. Items never merge while they wait: a metrics item is one frozen delta
 * window and a traces item one finished span, so a replay can never add to a
 * delta. A batch, once built, keeps its request id and exact bytes until the
 * service settles it, so a replay after a timeout or a crash is answered as a
 * duplicate. The channel's server gate, 429 wait and stop live here, apart from
 * the Logs and Usage channels, so a wait on one never holds another.
 */
export class OtlpBatchOutboxRepository<TItem> {
    private readonly lock = new FileLock()

    constructor(
        private readonly filePath: string,
        private readonly options: OtlpBatchOutboxOptions<TItem>,
    ) {}

    /**
     * Queue items; an item beyond the device admission or the backlog bound is
     * dropped and counted. `droppedBeforehand` counts items the caller already
     * had to discard, so they are reported too.
     */
    async append(items: readonly TItem[], now: number, droppedBeforehand = 0): Promise<void> {
        if (items.length === 0 && droppedBeforehand === 0) return
        await this.mutate((current) => {
            let quota = rollQuota(current.quota, now)
            const admitted: TItem[] = []
            let refused = 0
            for (const item of items) {
                if (!this.admits(quota, current.items.length + admitted.length)) {
                    refused++
                    continue
                }
                quota = countAdmitted(quota)
                admitted.push(item)
            }
            return {
                ...current,
                items: [...current.items, ...admitted],
                quota,
                dropped: current.dropped + refused + droppedBeforehand,
            }
        })
    }

    /** Items not yet acknowledged, the batch in flight included. */
    async backlog(): Promise<number> {
        const document = await this.read()
        return document.items.length + (document.inflight?.items.length ?? 0)
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
                if (age >= 0 && age < OTLP_BATCH_STOP_RETRY_MS) return current
                next = withoutStop(next)
            }
            if (next.claim && next.claim.owner !== owner && next.claim.until > now) return current
            const pacing = pacingOf(next.pacing)
            if (isWaiting(pacing, now)) return current
            let inflight = next.inflight
            let items = next.items
            let dropped = next.dropped
            let nextPacing = pacing
            if (inflight) {
                if (now < inflight.not_before) return current
            } else {
                if (items.length === 0 || !mayStartBatch(pacing, now)) return current
                inflight = this.buildInflight(items, dropped, now)
                items = items.slice(inflight.items.length)
                dropped = 0
                nextPacing = reserveInterval(pacing, this.options.channel, now)
            }
            claimed = { requestId: inflight.request_id, body: inflight.body }
            return {
                ...next,
                items,
                dropped,
                inflight,
                pacing: storedPacing(nextPacing),
                claim: { owner, until: now + OTLP_BATCH_CLAIM_TTL_MS },
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
            const lost = (document: OutboxDocument<TItem>) => ({
                ...document,
                dropped: document.dropped + inflight.dropped + inflight.items.length,
            })
            switch (settlement.kind) {
                case "acknowledged":
                    return {
                        ...rest,
                        pacing: storedPacing(
                            afterAcknowledged(pacingOf(rest.pacing), this.options.channel, settlement.nextEligibleAt, now),
                        ),
                    }
                case "replay": {
                    const attempts = inflight.attempts + 1
                    if (replayBudgetExhausted(attempts, inflight.created_at, now)) return lost(rest)
                    const notBefore = now + replayDelayMs(attempts, settlement.retryAfterMs)
                    return { ...released, inflight: { ...inflight, attempts, not_before: notBefore } }
                }
                case "wait": {
                    // The batch stays as it is and is replayed first once the wait ends;
                    // the wait does not count against the replay age.
                    const pacing = afterRateLimited(pacingOf(rest.pacing), settlement.retryAfterMs, now, this.options.random)
                    const waitedMs = Math.max(0, pacing.waitUntil - now)
                    return {
                        ...released,
                        inflight: { ...inflight, created_at: inflight.created_at + waitedMs, not_before: pacing.waitUntil },
                        pacing: storedPacing(pacing),
                    }
                }
                case "split": {
                    if (inflight.items.length <= 1) return lost(rest)
                    const half = Math.ceil(inflight.items.length / 2)
                    const first = this.buildInflight(inflight.items.slice(0, half), inflight.dropped, now)
                    return { ...rest, items: [...inflight.items.slice(half), ...rest.items], inflight: first }
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
     * Forget every queued item, for when reporting is turned off. The admission
     * counts, a running wait, the server gate and a stop are not data about the
     * user: they stay, so turning reporting off and on again cannot send early.
     */
    async clear(): Promise<void> {
        await mkdir(path.dirname(this.filePath), { recursive: true })
        await this.lock.withLock(this.filePath, async () => {
            const stored = await this.load()
            if (stored?.kind === "current") {
                const { quota, pacing, stop } = stored.document
                await writeJsonAtomic(
                    this.filePath,
                    { ...this.empty(), quota, pacing, ...(stop ? { stop } : {}) },
                    { fsync: true },
                )
                await rm(backupPathOf(this.filePath), { force: true })
                return
            }
            await Promise.all([rm(this.filePath, { force: true }), rm(backupPathOf(this.filePath), { force: true })])
        })
    }

    /** The current document; empty when there is none, it is unreadable, or a newer build owns it. */
    async read(): Promise<OutboxDocument<TItem>> {
        const stored = await this.load()
        return stored?.kind === "current" ? stored.document : this.empty()
    }

    private admits(quota: StoredQuota, pending: number): boolean {
        if (pending >= this.options.maxPendingItems) return false
        const admission = this.options.admission
        return !admission || (quota.hour_count < admission.perHour && quota.day_count < admission.perDay)
    }

    private empty(): OutboxDocument<TItem> {
        return { schema_version: SCHEMA_VERSION, items: [], dropped: 0, quota: EMPTY_QUOTA, pacing: EMPTY_PACING }
    }

    private async load(): Promise<StoredOutbox<TItem> | undefined> {
        const result = await readJsonWithBackup(this.filePath, (value) => this.parse(value))
        return result.status === "primary" || result.status === "backup" ? result.value : undefined
    }

    /** The most leading items that fit one request, at least one, encoded with the drops they report. */
    private buildInflight(items: readonly TItem[], dropped: number, now: number): Inflight<TItem> {
        let count = Math.min(items.length, this.options.maxItemsPerRequest)
        let body = this.options.encode(items.slice(0, count), dropped)
        while (count > 1 && Buffer.byteLength(body, "utf8") > OTLP_LIMITS.maxBodyBytes) {
            count = Math.max(1, Math.floor(count / 2))
            body = this.options.encode(items.slice(0, count), dropped)
        }
        return {
            request_id: randomUUID(),
            body,
            items: items.slice(0, count),
            dropped,
            created_at: now,
            attempts: 0,
            not_before: now,
        }
    }

    /** Apply a change under the lock; a document written by a newer build is left alone. */
    private async mutate(change: (current: OutboxDocument<TItem>) => OutboxDocument<TItem>): Promise<void> {
        await mkdir(path.dirname(this.filePath), { recursive: true })
        await this.lock.withLock(this.filePath, async () => {
            const stored = await this.load()
            if (stored?.kind === "newer") return
            const current = stored?.document ?? this.empty()
            const next = change(current)
            if (next !== current) await writeJsonAtomic(this.filePath, next, { fsync: true })
        })
    }

    /** Throws for anything that is not a complete document, as `readJsonWithBackup` requires. */
    private parse(value: unknown): StoredOutbox<TItem> {
        if (!isRecord(value) || !isCount(value.schema_version)) throw new Error("Not an OTLP batch outbox document")
        if (value.schema_version > SCHEMA_VERSION) return { kind: "newer" }
        const isItems = (items: unknown) => Array.isArray(items) && items.every((item) => this.options.isItem(item))
        const valid =
            value.schema_version === SCHEMA_VERSION &&
            isItems(value.items) &&
            isCount(value.dropped) &&
            isStoredQuota(value.quota) &&
            isStoredPacing(value.pacing) &&
            (value.inflight === undefined || (isInflight(value.inflight) && isItems(value.inflight.items))) &&
            (value.claim === undefined || isClaim(value.claim)) &&
            (value.stop === undefined || isStop(value.stop))
        if (!valid) throw new Error("Not an OTLP batch outbox document")
        return { kind: "current", document: value as unknown as OutboxDocument<TItem> }
    }
}

function withoutStop<TItem>({ stop: _stop, ...rest }: OutboxDocument<TItem>): OutboxDocument<TItem> {
    return rest
}

function withoutClaim<TItem>({ claim: _claim, ...rest }: OutboxDocument<TItem>): OutboxDocument<TItem> {
    return rest
}

function withoutInflight<TItem>({ inflight: _inflight, ...rest }: OutboxDocument<TItem>): OutboxDocument<TItem> {
    return rest
}

function isInflight(value: unknown): value is Record<string, unknown> {
    return (
        isRecord(value) &&
        typeof value.request_id === "string" &&
        typeof value.body === "string" &&
        isCount(value.dropped) &&
        isCount(value.created_at) &&
        isCount(value.attempts) &&
        isCount(value.not_before)
    )
}

function isClaim(value: unknown): boolean {
    return isRecord(value) && typeof value.owner === "string" && isCount(value.until)
}

function isStop(value: unknown): boolean {
    return isRecord(value) && typeof value.code === "string" && isCount(value.stopped_at)
}

function isCount(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
