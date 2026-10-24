import fs from "node:fs/promises"
import path from "node:path"
import { stableJsonStringify } from "@shared/stable-json"
import { writeJsonAtomic } from "@shared/storage/atomic-file"
import { FileLock } from "../backend/jsonl/FileLock"
import type { OtelStorageLayout } from "./OtelStorageLayout"
import { OWNER_ONLY_DIRECTORY_MODE, type QuarantineObserver, quarantineDocument } from "./quarantine"

const SCHEMA_VERSION = 1
const FILE_MODE = 0o600
const LOCK_ACQUIRE_ATTEMPTS = 50
const KINDS = ["create", "status", "revoke"] as const

export type SupportOperationKind = (typeof KINDS)[number]

export interface SupportOperationResponse {
    readonly status: number
    readonly json?: unknown
}

export interface SupportOperationIntent {
    readonly kind: SupportOperationKind
    readonly requestId: string
    readonly pathname: string
    readonly body: Readonly<Record<string, unknown>>
    /** Safe continuation state such as the confirmed ReportBug draft. */
    readonly context?: unknown
    readonly createdAt: number
    readonly response?: SupportOperationResponse
}

interface SupportOperationDocument {
    readonly pending?: SupportOperationIntent
}

export interface SupportOperationRepositoryOptions {
    readonly clock?: () => number
    readonly onQuarantine?: QuarantineObserver
}

/** Owner-only single-flight journal for exact support control-plane replay. */
export class SupportOperationRepository {
    private readonly lock = new FileLock({ maxAcquireAttempts: LOCK_ACQUIRE_ATTEMPTS })
    private readonly clock: () => number
    private readonly onQuarantine: QuarantineObserver | undefined

    constructor(
        private readonly layout: OtelStorageLayout,
        options: SupportOperationRepositoryOptions = {},
    ) {
        this.clock = options.clock ?? Date.now
        this.onQuarantine = options.onQuarantine
    }

    async read(): Promise<SupportOperationIntent | undefined> {
        try {
            return parseDocument(JSON.parse(await fs.readFile(this.layout.supportOperationPath, "utf8"))).pending
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
            return this.withLock(async () => (await this.readForWrite()).pending)
        }
    }

    /** Persist or recover the exact request before transport. */
    async prepare(input: Omit<SupportOperationIntent, "createdAt" | "response">): Promise<SupportOperationIntent> {
        const proposed = validateIntent({ ...input, createdAt: this.clock() })
        return this.withLock(async () => {
            const current = await this.readForWrite()
            if (current.pending) {
                if (!sameRequest(current.pending, proposed)) {
                    throw new Error("A different support operation is already pending")
                }
                return current.pending
            }
            await this.write({ pending: proposed })
            return proposed
        })
    }

    /** Seal the response before publishing credentials, status, Issue, or revoke completion. */
    async storeResponse(requestId: string, response: SupportOperationResponse): Promise<SupportOperationIntent> {
        return this.withLock(async () => {
            const current = await this.readForWrite()
            if (!current.pending || current.pending.requestId !== requestId) {
                throw new Error("Support operation changed before response publication")
            }
            const pending = validateIntent({ ...current.pending, response: validateResponse(response) })
            await this.write({ pending })
            return pending
        })
    }

    async complete(requestId: string): Promise<void> {
        await this.withLock(async () => {
            const current = await this.readForWrite()
            if (!current.pending || current.pending.requestId !== requestId) return
            await fs.rm(this.layout.supportOperationPath, { force: true })
        })
    }

    private async withLock<T>(operation: () => Promise<T>): Promise<T> {
        await fs.mkdir(this.layout.secretsDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
        return this.lock.withLock(this.layout.supportOperationPath, operation)
    }

    private async readForWrite(): Promise<SupportOperationDocument> {
        let raw: string
        try {
            raw = await fs.readFile(this.layout.supportOperationPath, "utf8")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
            throw error
        }
        try {
            return parseDocument(JSON.parse(raw))
        } catch {
            if (await quarantineDocument(this.layout.supportOperationPath, this.layout.secretsQuarantineDir, this.clock())) {
                this.onQuarantine?.(path.basename(this.layout.supportOperationPath))
            }
            return {}
        }
    }

    private write(document: SupportOperationDocument): Promise<void> {
        return writeJsonAtomic(
            this.layout.supportOperationPath,
            {
                schema_version: SCHEMA_VERSION,
                ...(document.pending ? { pending: serializeIntent(document.pending) } : {}),
            },
            { mode: FILE_MODE, fsync: true },
        )
    }
}

function validateIntent(intent: SupportOperationIntent): SupportOperationIntent {
    if (!KINDS.includes(intent.kind) || !intent.requestId || !intent.pathname.startsWith("/support/authorizations")) {
        throw new Error("Invalid support operation intent")
    }
    if (!Number.isSafeInteger(intent.createdAt) || intent.createdAt < 0) throw new Error("Invalid support operation timestamp")
    return {
        ...intent,
        body: { ...intent.body },
        ...(intent.response ? { response: validateResponse(intent.response) } : {}),
    }
}

function validateResponse(response: SupportOperationResponse): SupportOperationResponse {
    if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599) {
        throw new Error("Invalid support operation response")
    }
    return { status: response.status, ...(response.json === undefined ? {} : { json: response.json }) }
}

function sameRequest(left: SupportOperationIntent, right: SupportOperationIntent): boolean {
    return (
        left.kind === right.kind &&
        left.pathname === right.pathname &&
        stableJsonStringify(left.body) === stableJsonStringify(right.body) &&
        stableJsonStringify(left.context) === stableJsonStringify(right.context)
    )
}

function parseDocument(value: unknown): SupportOperationDocument {
    if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION) throw new Error("Invalid support operation journal")
    return value.pending === undefined ? {} : { pending: parseIntent(value.pending) }
}

function parseIntent(value: unknown): SupportOperationIntent {
    if (!isRecord(value) || !isRecord(value.body)) throw new Error("Invalid support operation intent")
    return validateIntent({
        kind: value.kind as SupportOperationKind,
        requestId: String(value.request_id ?? ""),
        pathname: String(value.pathname ?? ""),
        body: value.body,
        context: value.context,
        createdAt: Number(value.created_at),
        ...(value.response === undefined ? {} : { response: parseResponse(value.response) }),
    })
}

function parseResponse(value: unknown): SupportOperationResponse {
    if (!isRecord(value)) throw new Error("Invalid support operation response")
    return validateResponse({ status: Number(value.status), ...(value.json === undefined ? {} : { json: value.json }) })
}

function serializeIntent(intent: SupportOperationIntent): Record<string, unknown> {
    return {
        kind: intent.kind,
        request_id: intent.requestId,
        pathname: intent.pathname,
        body: intent.body,
        context: intent.context,
        created_at: intent.createdAt,
        ...(intent.response ? { response: intent.response } : {}),
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
