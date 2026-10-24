import fs from "node:fs/promises"
import path from "node:path"
import { writeJsonAtomic } from "@shared/storage/atomic-file"
import { FileLock } from "../backend/jsonl/FileLock"
import type { OtelStorageLayout } from "./OtelStorageLayout"
import { OWNER_ONLY_DIRECTORY_MODE, type QuarantineObserver, quarantineDocument } from "./quarantine"

const SCHEMA_VERSION = 1
const FILE_MODE = 0o600
const LOCK_ACQUIRE_ATTEMPTS = 50

export type SupportAuthorizationState = "awaiting_issue" | "pending_approval" | "approved" | "revoked" | "expired" | "deleted"

export interface SupportIssueReference {
    readonly owner: string
    readonly repo: string
    readonly number: number
}

/** Owner-only authority. Only safe projections may leave this repository. */
export interface IssueCredentialRecord {
    readonly authorizationId: string
    readonly publicCode: string
    readonly resumeCredential: string
    readonly state: SupportAuthorizationState
    readonly revision: number
    readonly authorizationExpiresAt: number
    readonly pollAfterMs: number
    readonly issue?: SupportIssueReference
    readonly captureExpiresAt?: number
    readonly exchangeTicket?: string
    readonly exchangeTicketExpiresAt?: number
}

export interface IssueRevokeTombstone {
    readonly authorizationId: string
    readonly resumeCredential: string
    readonly expectedRevision: number
    readonly naturalExpiresAt: number
    readonly createdAt: number
}

interface IssueCredentialDocument {
    readonly record?: IssueCredentialRecord
    readonly revokeTombstone?: IssueRevokeTombstone
}

export interface IssueCredentialRepositoryOptions {
    readonly clock?: () => number
    readonly onQuarantine?: QuarantineObserver
}

/** Single-writer owner-only support authorization and revoke state. */
export class IssueCredentialRepository {
    private readonly lock = new FileLock({ maxAcquireAttempts: LOCK_ACQUIRE_ATTEMPTS })
    private readonly clock: () => number
    private readonly onQuarantine: QuarantineObserver | undefined

    constructor(
        private readonly layout: OtelStorageLayout,
        options: IssueCredentialRepositoryOptions = {},
    ) {
        this.clock = options.clock ?? Date.now
        this.onQuarantine = options.onQuarantine
    }

    async read(): Promise<IssueCredentialDocument> {
        try {
            return parseDocument(JSON.parse(await fs.readFile(this.layout.issueCredentialPath, "utf8")))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
            // Re-read under the writer lock before quarantining: another process may
            // already have replaced the malformed bytes with a valid document.
            return this.withLock(() => this.readForWrite())
        }
    }

    async publish(record: IssueCredentialRecord): Promise<void> {
        const validated = validateRecord(record)
        await this.withLock(async () => {
            const current = await this.readForWrite()
            if (
                current.revokeTombstone &&
                current.revokeTombstone.authorizationId === validated.authorizationId &&
                current.revokeTombstone.expectedRevision >= validated.revision
            ) {
                throw new Error("Refusing to reactivate a revoked support authorization revision")
            }
            await this.write({ record: validated })
        })
    }

    async writeRevokeTombstone(): Promise<IssueRevokeTombstone | undefined> {
        return this.withLock(async () => {
            const current = await this.readForWrite()
            if (current.revokeTombstone) return current.revokeTombstone
            if (!current.record) return undefined
            const tombstone: IssueRevokeTombstone = {
                authorizationId: current.record.authorizationId,
                resumeCredential: current.record.resumeCredential,
                expectedRevision: current.record.revision,
                naturalExpiresAt: current.record.captureExpiresAt ?? current.record.authorizationExpiresAt,
                createdAt: this.clock(),
            }
            await this.write({ revokeTombstone: tombstone })
            return tombstone
        })
    }

    async clearAfterConfirmedRevoke(): Promise<void> {
        await this.withLock(() => fs.rm(this.layout.issueCredentialPath, { force: true }))
    }

    async pruneNaturalExpiry(now: number): Promise<void> {
        await this.withLock(async () => {
            const current = await this.readForWrite()
            if (!current.revokeTombstone || current.revokeTombstone.naturalExpiresAt > now) return
            await fs.rm(this.layout.issueCredentialPath, { force: true })
        })
    }

    private async withLock<T>(operation: () => Promise<T>): Promise<T> {
        await fs.mkdir(this.layout.secretsDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
        return this.lock.withLock(this.layout.issueCredentialPath, operation)
    }

    private async readForWrite(): Promise<IssueCredentialDocument> {
        let raw: string
        try {
            raw = await fs.readFile(this.layout.issueCredentialPath, "utf8")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
            throw error
        }
        try {
            return parseDocument(JSON.parse(raw))
        } catch {
            if (await quarantineDocument(this.layout.issueCredentialPath, this.layout.secretsQuarantineDir, this.clock())) {
                this.onQuarantine?.(path.basename(this.layout.issueCredentialPath))
            }
            return {}
        }
    }

    private write(document: IssueCredentialDocument): Promise<void> {
        return writeJsonAtomic(this.layout.issueCredentialPath, serializeDocument(document), { mode: FILE_MODE, fsync: true })
    }
}

function validateRecord(record: IssueCredentialRecord): IssueCredentialRecord {
    if (
        !record.authorizationId ||
        !record.publicCode ||
        !record.resumeCredential ||
        !Number.isSafeInteger(record.revision) ||
        record.revision <= 0 ||
        !Number.isSafeInteger(record.authorizationExpiresAt) ||
        !Number.isSafeInteger(record.pollAfterMs) ||
        record.pollAfterMs < 0
    ) {
        throw new Error("Invalid support authorization credential")
    }
    return { ...record, ...(record.issue ? { issue: { ...record.issue } } : {}) }
}

function parseDocument(value: unknown): IssueCredentialDocument {
    if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION) throw new Error("Invalid issue credential document")
    const record = value.record === undefined ? undefined : parseRecord(value.record)
    const revokeTombstone = value.revoke_tombstone === undefined ? undefined : parseTombstone(value.revoke_tombstone)
    return { ...(record ? { record } : {}), ...(revokeTombstone ? { revokeTombstone } : {}) }
}

function parseRecord(value: unknown): IssueCredentialRecord {
    if (!isRecord(value)) throw new Error("Invalid support authorization record")
    const issue = isRecord(value.issue)
        ? { owner: String(value.issue.owner), repo: String(value.issue.repo), number: Number(value.issue.number) }
        : undefined
    return validateRecord({
        authorizationId: String(value.authorization_id ?? ""),
        publicCode: String(value.public_code ?? ""),
        resumeCredential: String(value.resume_credential ?? ""),
        state: String(value.state ?? "") as SupportAuthorizationState,
        revision: Number(value.revision),
        authorizationExpiresAt: Number(value.authorization_expires_at),
        pollAfterMs: Number(value.poll_after_ms),
        ...(issue ? { issue } : {}),
        ...(value.capture_expires_at === undefined ? {} : { captureExpiresAt: Number(value.capture_expires_at) }),
        ...(value.exchange_ticket === undefined ? {} : { exchangeTicket: String(value.exchange_ticket) }),
        ...(value.exchange_ticket_expires_at === undefined
            ? {}
            : { exchangeTicketExpiresAt: Number(value.exchange_ticket_expires_at) }),
    })
}

function parseTombstone(value: unknown): IssueRevokeTombstone {
    if (!isRecord(value)) throw new Error("Invalid support revoke tombstone")
    const tombstone = {
        authorizationId: String(value.authorization_id ?? ""),
        resumeCredential: String(value.resume_credential ?? ""),
        expectedRevision: Number(value.expected_revision),
        naturalExpiresAt: Number(value.natural_expires_at),
        createdAt: Number(value.created_at),
    }
    if (!tombstone.authorizationId || !tombstone.resumeCredential || !Number.isSafeInteger(tombstone.expectedRevision)) {
        throw new Error("Invalid support revoke tombstone")
    }
    return tombstone
}

function serializeDocument(document: IssueCredentialDocument): Record<string, unknown> {
    return {
        schema_version: SCHEMA_VERSION,
        ...(document.record
            ? {
                  record: {
                      authorization_id: document.record.authorizationId,
                      public_code: document.record.publicCode,
                      resume_credential: document.record.resumeCredential,
                      state: document.record.state,
                      revision: document.record.revision,
                      authorization_expires_at: document.record.authorizationExpiresAt,
                      poll_after_ms: document.record.pollAfterMs,
                      ...(document.record.issue ? { issue: document.record.issue } : {}),
                      ...(document.record.captureExpiresAt === undefined
                          ? {}
                          : { capture_expires_at: document.record.captureExpiresAt }),
                      ...(document.record.exchangeTicket === undefined
                          ? {}
                          : { exchange_ticket: document.record.exchangeTicket }),
                      ...(document.record.exchangeTicketExpiresAt === undefined
                          ? {}
                          : { exchange_ticket_expires_at: document.record.exchangeTicketExpiresAt }),
                  },
              }
            : {}),
        ...(document.revokeTombstone
            ? {
                  revoke_tombstone: {
                      authorization_id: document.revokeTombstone.authorizationId,
                      resume_credential: document.revokeTombstone.resumeCredential,
                      expected_revision: document.revokeTombstone.expectedRevision,
                      natural_expires_at: document.revokeTombstone.naturalExpiresAt,
                      created_at: document.revokeTombstone.createdAt,
                  },
              }
            : {}),
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
