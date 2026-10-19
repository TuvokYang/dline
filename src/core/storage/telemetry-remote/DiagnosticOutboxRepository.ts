import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { backupPathOf, readJsonWithBackup, writeJsonAtomic } from "@shared/storage/atomic-file"
import type { DiagnosticRecord } from "@/services/telemetry/remote/diagnostics/diagnosticRecord"
import { FileLock } from "../backend/jsonl/FileLock"

/** Records kept while the service cannot be reached; the oldest go first. */
export const MAX_PENDING_DIAGNOSTICS = 2_000
/** The service accepts at most 256 records per request. */
export const MAX_DIAGNOSTICS_PER_REQUEST = 256
/** Stay well below the 512 KiB request limit of the production profile. */
export const MAX_DIAGNOSTICS_REQUEST_BYTES = 384 * 1024
/** How long one window may hold a batch before another may send it instead. */
export const DIAGNOSTICS_CLAIM_TTL_MS = 60_000
/** A stop the service asked for is retried after this long, never sooner. */
export const DIAGNOSTICS_STOP_RETRY_MS = 30 * 60_000

/** A batch this window sends now; the same id and bytes are sent again until it settles. */
export interface ClaimedDiagnostics {
    readonly requestId: string
    readonly body: string
}

export type DiagnosticSettlement =
    | { readonly kind: "delivered" }
    | { readonly kind: "retry"; readonly at: number }
    | { readonly kind: "stopped"; readonly code: string }

interface OutboxDocument {
    readonly schema_version: 1
    readonly records: DiagnosticRecord[]
    readonly dropped: number
    readonly inflight?: { readonly request_id: string; readonly body: string }
    readonly claim?: { readonly owner: string; readonly until: number }
    readonly next_attempt_at: number
    readonly stop?: { readonly code: string; readonly stopped_at: number }
}

const EMPTY: OutboxDocument = { schema_version: 1, records: [], dropped: 0, next_attempt_at: 0 }

/**
 * The machine-wide queue of diagnostic records waiting for `/v1/logs`.
 *
 * Every window appends to it and any one window sends from it, under one file
 * lock. A batch, once built, keeps its request id and exact bytes until the
 * service settles it, so a replay after a timeout or a crash is recognised as a
 * duplicate rather than stored twice.
 */
export class DiagnosticOutboxRepository {
    private readonly lock = new FileLock()

    constructor(private readonly filePath: string) {}

    async append(records: readonly DiagnosticRecord[]): Promise<void> {
        if (records.length === 0) return
        await this.mutate((current) => {
            const all = [...current.records, ...records]
            const overflow = Math.max(0, all.length - MAX_PENDING_DIAGNOSTICS)
            return { ...current, records: all.slice(overflow), dropped: current.dropped + overflow }
        })
    }

    /** Take the batch to send now, or undefined when another window holds it, it is not due, or the service said stop. */
    async claim(
        owner: string,
        now: number,
        encode: (records: readonly DiagnosticRecord[]) => string,
    ): Promise<ClaimedDiagnostics | undefined> {
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
            if (next.next_attempt_at > now) return current
            let inflight = next.inflight
            let records = next.records
            if (!inflight) {
                if (records.length === 0) return current
                const batch = largestBatch(records, encode)
                inflight = { request_id: randomUUID(), body: batch.body }
                records = records.slice(batch.count)
            }
            claimed = { requestId: inflight.request_id, body: inflight.body }
            return { ...next, records, inflight, claim: { owner, until: now + DIAGNOSTICS_CLAIM_TTL_MS } }
        })
        return claimed
    }

    /** Record how the service answered the batch this window claimed. */
    async settle(owner: string, requestId: string, settlement: DiagnosticSettlement, now: number): Promise<void> {
        await this.mutate((current) => {
            if (current.inflight?.request_id !== requestId) return current
            const released = current.claim?.owner === owner ? withoutClaim(current) : current
            switch (settlement.kind) {
                case "delivered":
                    return { ...withoutInflight(released), next_attempt_at: 0 }
                case "retry":
                    return { ...released, next_attempt_at: settlement.at }
                case "stopped":
                    return { ...released, stop: { code: settlement.code, stopped_at: now } }
            }
        })
    }

    /** Forget every queued record, for when error reporting is turned off. */
    async clear(): Promise<void> {
        await this.lock.withLock(this.filePath, async () => {
            await Promise.all([rm(this.filePath, { force: true }), rm(backupPathOf(this.filePath), { force: true })])
        })
    }

    async read(): Promise<OutboxDocument> {
        const result = await readJsonWithBackup(this.filePath, parseOutbox)
        return result.status === "primary" || result.status === "backup" ? result.value : EMPTY
    }

    private async mutate(change: (current: OutboxDocument) => OutboxDocument): Promise<void> {
        await mkdir(path.dirname(this.filePath), { recursive: true })
        await this.lock.withLock(this.filePath, async () => {
            const current = await this.read()
            const next = change(current)
            if (next !== current) await writeJsonAtomic(this.filePath, next)
        })
    }
}

/** The most leading records that fit one request, at least one. */
function largestBatch(
    records: readonly DiagnosticRecord[],
    encode: (records: readonly DiagnosticRecord[]) => string,
): { count: number; body: string } {
    let count = Math.min(records.length, MAX_DIAGNOSTICS_PER_REQUEST)
    let body = encode(records.slice(0, count))
    while (count > 1 && Buffer.byteLength(body, "utf8") > MAX_DIAGNOSTICS_REQUEST_BYTES) {
        count = Math.max(1, Math.floor(count / 2))
        body = encode(records.slice(0, count))
    }
    return { count, body }
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

/** Throws for anything that is not an outbox document, as `readJsonWithBackup` requires. */
function parseOutbox(value: unknown): OutboxDocument {
    const document = value as Partial<OutboxDocument> | null
    if (
        document?.schema_version !== 1 ||
        !Array.isArray(document.records) ||
        typeof document.dropped !== "number" ||
        typeof document.next_attempt_at !== "number"
    ) {
        throw new Error("Not a diagnostic outbox document")
    }
    return document as OutboxDocument
}
