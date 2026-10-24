import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { readJsonWithBackup, writeJsonAtomic } from "@shared/storage/atomic-file"
import type { AtomicIssueGrant } from "@/services/telemetry/remote/contracts/issueGrant"
import type { DiagnosticResource } from "@/services/telemetry/remote/diagnostics/diagnosticRecord"
import {
    encodeIssueDiagnosticBatch,
    type IssueDiagnosticItem,
    type IssueDiagnosticStream,
} from "@/services/telemetry/remote/diagnostics/issueDiagnosticRecord"
import { FileLock } from "../backend/jsonl/FileLock"
import type { OtelStorageLayout } from "./OtelStorageLayout"

const SCHEMA_VERSION = 1
const CLAIM_TTL_MS = 60_000
const RETRY_MS = 30_000
const MAX_REPLAYS = 12
const MAX_PENDING = 5_000
const MAX_BATCH_RECORDS = 250

export interface ClaimedIssueDiagnostics {
    readonly requestId: string
    readonly stream: IssueDiagnosticStream
    readonly body: string
}

export type IssueDiagnosticSettlement =
    | { readonly kind: "acknowledged" }
    | { readonly kind: "replay"; readonly retryAfterMs?: number }
    | { readonly kind: "split" }
    | { readonly kind: "discard" }
    | { readonly kind: "sealed" }

interface StoredGrant {
    readonly authorization_id: string
    readonly authorization_revision: number
    readonly expires_at: number
    readonly capture_expires_at: number
    readonly max_request_bytes: number
    readonly max_requests: number
    readonly max_records: number
}

interface Inflight {
    readonly request_id: string
    readonly stream: IssueDiagnosticStream
    readonly body: string
    readonly items: readonly IssueDiagnosticItem[]
    readonly attempts: number
    readonly not_before: number
}

interface Document {
    readonly schema_version: typeof SCHEMA_VERSION
    readonly grant?: StoredGrant
    readonly items: readonly IssueDiagnosticItem[]
    readonly acknowledged_requests: number
    readonly acknowledged_records: number
    readonly inflight?: Inflight
    readonly claim?: { readonly owner: string; readonly until: number }
}

const EMPTY: Document = {
    schema_version: SCHEMA_VERSION,
    items: [],
    acknowledged_requests: 0,
    acknowledged_records: 0,
}

/** Durable issue-only partition. Production diagnostics and Usage never share this file or its fences. */
export class IssueDiagnosticOutboxRepository {
    private readonly lock = new FileLock()

    constructor(
        private readonly layout: OtelStorageLayout,
        private readonly resource: DiagnosticResource,
    ) {}

    async append(grant: AtomicIssueGrant, incoming: readonly IssueDiagnosticItem[], now: number): Promise<void> {
        if (incoming.length === 0) return
        await this.mutate((stored) => {
            const current = sameGrant(stored.grant, grant) ? stored : fresh(grant)
            if (grant.expiresAt <= now || grant.captureExpiresAt <= now) return EMPTY
            const room = Math.max(
                0,
                Math.min(MAX_PENDING, grant.rateLimits.maxRecords - current.acknowledged_records) -
                    current.items.length -
                    (current.inflight?.items.length ?? 0),
            )
            return { ...current, items: [...current.items, ...incoming.slice(0, room)] }
        })
    }

    async claim(owner: string, grant: AtomicIssueGrant, now: number): Promise<ClaimedIssueDiagnostics | undefined> {
        let claimed: ClaimedIssueDiagnostics | undefined
        await this.mutate((stored) => {
            const current = sameGrant(stored.grant, grant) ? stored : fresh(grant)
            if (grant.expiresAt <= now || grant.captureExpiresAt <= now) return EMPTY
            if (current.claim && current.claim.owner !== owner && current.claim.until > now) return current
            if (current.acknowledged_requests >= grant.rateLimits.maxRequests) return current
            let inflight = current.inflight
            let items = current.items
            if (inflight) {
                if (inflight.not_before > now) return current
            } else {
                if (items.length === 0) return current
                inflight = this.buildInflight(items, grant.rateLimits.maxRequestBytes, now)
                items = removeSelected(items, inflight.items)
            }
            claimed = { requestId: inflight.request_id, stream: inflight.stream, body: inflight.body }
            return { ...current, items, inflight, claim: { owner, until: now + CLAIM_TTL_MS } }
        })
        return claimed
    }

    async settle(owner: string, requestId: string, settlement: IssueDiagnosticSettlement, now: number): Promise<void> {
        await this.mutate((current) => {
            const inflight = current.inflight
            if (!inflight || inflight.request_id !== requestId) return current
            const released = current.claim?.owner === owner ? withoutClaim(current) : current
            const base = withoutInflight(released)
            switch (settlement.kind) {
                case "acknowledged":
                    return {
                        ...base,
                        acknowledged_requests: base.acknowledged_requests + 1,
                        acknowledged_records: base.acknowledged_records + inflight.items.length,
                    }
                case "replay": {
                    const attempts = inflight.attempts + 1
                    if (attempts >= MAX_REPLAYS) return base
                    return {
                        ...released,
                        inflight: {
                            ...inflight,
                            attempts,
                            not_before: now + Math.max(RETRY_MS, settlement.retryAfterMs ?? 0),
                        },
                    }
                }
                case "split": {
                    if (inflight.items.length <= 1) return base
                    const half = Math.ceil(inflight.items.length / 2)
                    const first = this.buildInflight(inflight.items.slice(0, half), Number.MAX_SAFE_INTEGER, now)
                    return { ...base, items: [...inflight.items.slice(half), ...base.items], inflight: first }
                }
                case "discard":
                    return base
                case "sealed":
                    return EMPTY
            }
        })
    }

    async clear(): Promise<void> {
        await fs.mkdir(path.dirname(this.layout.issueDiagnosticsOutboxPath), { recursive: true })
        await this.lock.withLock(this.layout.issueDiagnosticsOutboxPath, () =>
            fs.rm(this.layout.issueDiagnosticsOutboxPath, { force: true }),
        )
    }

    async read(): Promise<Document> {
        const result = await readJsonWithBackup(this.layout.issueDiagnosticsOutboxPath, parseDocument)
        return result.status === "primary" || result.status === "backup" ? result.value : EMPTY
    }

    private buildInflight(items: readonly IssueDiagnosticItem[], maxBytes: number, now: number): Inflight {
        const stream = items[0].stream
        const sameStream = items.filter((item) => item.stream === stream).slice(0, MAX_BATCH_RECORDS)
        let count = sameStream.length
        let selected = sameStream
        let body = encodeIssueDiagnosticBatch(selected, this.resource)
        while (count > 1 && Buffer.byteLength(body, "utf8") > maxBytes) {
            count = Math.max(1, Math.floor(count / 2))
            selected = sameStream.slice(0, count)
            body = encodeIssueDiagnosticBatch(selected, this.resource)
        }
        return {
            request_id: randomUUID(),
            stream,
            body,
            items: selected,
            attempts: 0,
            not_before: now,
        }
    }

    private async mutate(update: (current: Document) => Document): Promise<void> {
        await fs.mkdir(path.dirname(this.layout.issueDiagnosticsOutboxPath), { recursive: true })
        await this.lock.withLock(this.layout.issueDiagnosticsOutboxPath, async () => {
            const next = update(await this.read())
            if (isEmpty(next)) {
                await fs.rm(this.layout.issueDiagnosticsOutboxPath, { force: true })
                return
            }
            await writeJsonAtomic(this.layout.issueDiagnosticsOutboxPath, next, { fsync: true })
        })
    }
}

function fresh(grant: AtomicIssueGrant): Document {
    return { ...EMPTY, grant: storedGrant(grant) }
}

function storedGrant(grant: AtomicIssueGrant): StoredGrant {
    return {
        authorization_id: grant.authorizationId,
        authorization_revision: grant.authorizationRevision,
        expires_at: grant.expiresAt,
        capture_expires_at: grant.captureExpiresAt,
        max_request_bytes: grant.rateLimits.maxRequestBytes,
        max_requests: grant.rateLimits.maxRequests,
        max_records: grant.rateLimits.maxRecords,
    }
}

function sameGrant(stored: StoredGrant | undefined, grant: AtomicIssueGrant): boolean {
    return Boolean(
        stored &&
            stored.authorization_id === grant.authorizationId &&
            stored.authorization_revision === grant.authorizationRevision &&
            stored.expires_at === grant.expiresAt &&
            stored.capture_expires_at === grant.captureExpiresAt &&
            stored.max_request_bytes === grant.rateLimits.maxRequestBytes &&
            stored.max_requests === grant.rateLimits.maxRequests &&
            stored.max_records === grant.rateLimits.maxRecords,
    )
}

function removeSelected(all: readonly IssueDiagnosticItem[], selected: readonly IssueDiagnosticItem[]): IssueDiagnosticItem[] {
    const remaining = [...all]
    for (const item of selected) {
        const index = remaining.indexOf(item)
        if (index >= 0) remaining.splice(index, 1)
    }
    return remaining
}

function withoutClaim(document: Document): Document {
    const { claim: _claim, ...rest } = document
    return rest
}

function withoutInflight(document: Document): Document {
    const { inflight: _inflight, ...rest } = document
    return rest
}

function isEmpty(document: Document): boolean {
    return !document.grant && document.items.length === 0 && !document.inflight
}

function parseDocument(value: unknown): Document {
    if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION || !Array.isArray(value.items)) {
        throw new Error("Invalid issue diagnostic outbox")
    }
    const grant = value.grant === undefined ? undefined : parseGrant(value.grant)
    const inflight = value.inflight === undefined ? undefined : parseInflight(value.inflight)
    const claim = value.claim === undefined ? undefined : parseClaim(value.claim)
    return {
        schema_version: SCHEMA_VERSION,
        ...(grant ? { grant } : {}),
        items: value.items.map(parseItem),
        acknowledged_requests: nonNegative(value.acknowledged_requests),
        acknowledged_records: nonNegative(value.acknowledged_records),
        ...(inflight ? { inflight } : {}),
        ...(claim ? { claim } : {}),
    }
}

function parseGrant(value: unknown): StoredGrant {
    if (!isRecord(value)) throw new Error("Invalid issue diagnostic grant fence")
    return {
        authorization_id: stringValue(value.authorization_id),
        authorization_revision: positive(value.authorization_revision),
        expires_at: nonNegative(value.expires_at),
        capture_expires_at: nonNegative(value.capture_expires_at),
        max_request_bytes: positive(value.max_request_bytes),
        max_requests: nonNegative(value.max_requests),
        max_records: nonNegative(value.max_records),
    }
}

function parseInflight(value: unknown): Inflight {
    if (!isRecord(value) || !Array.isArray(value.items) || !isStream(value.stream)) throw new Error("Invalid issue inflight")
    return {
        request_id: stringValue(value.request_id),
        stream: value.stream,
        body: stringValue(value.body),
        items: value.items.map(parseItem),
        attempts: nonNegative(value.attempts),
        not_before: nonNegative(value.not_before),
    }
}

function parseClaim(value: unknown): { owner: string; until: number } {
    if (!isRecord(value)) throw new Error("Invalid issue claim")
    return { owner: stringValue(value.owner), until: nonNegative(value.until) }
}

function parseItem(value: unknown): IssueDiagnosticItem {
    if (!isRecord(value) || !isStream(value.stream)) throw new Error("Invalid issue diagnostic item")
    return value as unknown as IssueDiagnosticItem
}

function isStream(value: unknown): value is IssueDiagnosticStream {
    return value === "logs" || value === "metrics" || value === "traces"
}

function stringValue(value: unknown): string {
    if (typeof value !== "string" || value.length === 0) throw new Error("Invalid issue diagnostic string")
    return value
}

function positive(value: unknown): number {
    const parsed = nonNegative(value)
    if (parsed <= 0) throw new Error("Invalid positive integer")
    return parsed
}

function nonNegative(value: unknown): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid non-negative integer")
    return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
