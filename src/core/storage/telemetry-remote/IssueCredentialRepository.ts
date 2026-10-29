import fs from "node:fs/promises"
import path from "node:path"
import { writeJsonAtomic } from "@shared/storage/atomic-file"
import {
    parseReportResolution,
    REPORT_AUTHORIZATION_STATES,
    REPORT_ISSUE_STATES,
    type ReportAuthorizationState,
    type ReportIssueState,
    type ReportResolution,
    serializeReportResolution,
} from "@/services/telemetry/remote/contracts/reportAuthorization"
import { deriveSupportCode, isAuthorizationCode } from "@/services/telemetry/remote/contracts/supportCode"
import { FileLock } from "../backend/jsonl/FileLock"
import type { OtelStorageLayout } from "./OtelStorageLayout"
import { OWNER_ONLY_DIRECTORY_MODE, type QuarantineObserver, quarantineDocument } from "./quarantine"

/** Version 1 held the retired pairing and control-plane record; it is quarantined, never migrated. */
const SCHEMA_VERSION = 2
const FILE_MODE = 0o600
const LOCK_ACQUIRE_ATTEMPTS = 50

export type SupportAuthorizationState = ReportAuthorizationState

/**
 * The one Report Authorization ticket of this machine (telemetry-exchange-flow §5).
 *
 * Owner-only: the authorization code never leaves this repository except to
 * the status query and `/auth/exchange`. It holds no Issue identity, because
 * OTel never returns one.
 */
export interface IssueCredentialRecord {
    readonly authorizationCode: string
    readonly publicCode: string
    readonly state: ReportAuthorizationState
    readonly revision: number
    readonly authorizationExpiresAt: number
    readonly captureExpiresAt?: number
    readonly ticketExpiresAt: number
    readonly issueState: ReportIssueState
    readonly resolution: ReportResolution
    readonly pollAfterMs: number
}

interface IssueCredentialDocument {
    readonly record?: IssueCredentialRecord
}

export interface IssueCredentialRepositoryOptions {
    readonly clock?: () => number
    readonly onQuarantine?: QuarantineObserver
}

/** Single-writer owner-only Report Authorization ticket store. */
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

    /** Install a newly issued ticket, replacing whatever ticket this machine held before. */
    async replace(record: IssueCredentialRecord): Promise<void> {
        const validated = validateRecord(record)
        await this.withLock(() => this.write({ record: validated }))
    }

    /**
     * Apply a status result to the ticket it was queried for.
     *
     * Returns the stored record, or `undefined` when the ticket was replaced or
     * deleted meanwhile, so a late answer for an old code never overwrites the
     * current one.
     */
    async update(
        authorizationCode: string,
        mutate: (current: IssueCredentialRecord) => IssueCredentialRecord,
    ): Promise<IssueCredentialRecord | undefined> {
        return this.withLock(async () => {
            const current = (await this.readForWrite()).record
            if (current?.authorizationCode !== authorizationCode) return undefined
            const next = validateRecord(mutate(current))
            if (next.authorizationCode !== authorizationCode) throw new Error("A status update cannot change the ticket")
            await this.write({ record: next })
            return next
        })
    }

    /** Delete the ticket; with a code, only when it is still the stored one. */
    async clear(authorizationCode?: string): Promise<void> {
        await this.withLock(async () => {
            if (authorizationCode !== undefined) {
                const current = (await this.readForWrite()).record
                if (current?.authorizationCode !== authorizationCode) return
            }
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
    const valid =
        isAuthorizationCode(record.authorizationCode) &&
        record.publicCode === deriveSupportCode(record.authorizationCode) &&
        (REPORT_AUTHORIZATION_STATES as readonly string[]).includes(record.state) &&
        (REPORT_ISSUE_STATES as readonly string[]).includes(record.issueState) &&
        isNonNegativeInteger(record.revision) &&
        isNonNegativeInteger(record.pollAfterMs) &&
        isTimestamp(record.authorizationExpiresAt) &&
        isTimestamp(record.ticketExpiresAt) &&
        record.ticketExpiresAt >= record.authorizationExpiresAt &&
        (record.captureExpiresAt === undefined || isTimestamp(record.captureExpiresAt)) &&
        parseReportResolution(serializeReportResolution(record.resolution)) !== undefined
    if (!valid) throw new Error("Invalid report authorization ticket")
    return { ...record, resolution: { ...record.resolution } }
}

function parseDocument(value: unknown): IssueCredentialDocument {
    if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION) throw new Error("Invalid issue credential document")
    return value.ticket === undefined ? {} : { record: parseRecord(value.ticket) }
}

function parseRecord(value: unknown): IssueCredentialRecord {
    if (!isRecord(value)) throw new Error("Invalid report authorization ticket")
    const resolution = parseReportResolution(value.resolution)
    if (!resolution) throw new Error("Invalid report authorization ticket")
    return validateRecord({
        authorizationCode: value.authorization_code as string,
        publicCode: value.public_code as string,
        state: value.state as ReportAuthorizationState,
        revision: value.authorization_revision as number,
        authorizationExpiresAt: value.authorization_expires_at as number,
        ...(value.capture_expires_at === undefined ? {} : { captureExpiresAt: value.capture_expires_at as number }),
        ticketExpiresAt: value.ticket_expires_at as number,
        issueState: value.issue_state as ReportIssueState,
        resolution,
        pollAfterMs: value.poll_after_ms as number,
    })
}

function serializeDocument(document: IssueCredentialDocument): Record<string, unknown> {
    const record = document.record
    return {
        schema_version: SCHEMA_VERSION,
        ...(record
            ? {
                  ticket: {
                      authorization_code: record.authorizationCode,
                      public_code: record.publicCode,
                      state: record.state,
                      authorization_revision: record.revision,
                      authorization_expires_at: record.authorizationExpiresAt,
                      ...(record.captureExpiresAt === undefined ? {} : { capture_expires_at: record.captureExpiresAt }),
                      ticket_expires_at: record.ticketExpiresAt,
                      issue_state: record.issueState,
                      resolution: serializeReportResolution(record.resolution),
                      poll_after_ms: record.pollAfterMs,
                  },
              }
            : {}),
    }
}

function isTimestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
