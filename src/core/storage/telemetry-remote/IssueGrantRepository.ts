import fs from "node:fs/promises"
import path from "node:path"
import { writeJsonAtomic } from "@shared/storage/atomic-file"
import type { IssueGrantPort } from "@/services/telemetry/remote/auth/IssueGrantPort"
import {
    type AtomicIssueGrant,
    parseAtomicIssueGrant,
    sameAtomicIssueGrant,
    serializeAtomicIssueGrant,
    validateAtomicIssueGrant,
} from "@/services/telemetry/remote/contracts/issueGrant"
import { FileLock } from "../backend/jsonl/FileLock"
import type { OtelStorageLayout } from "./OtelStorageLayout"
import { OWNER_ONLY_DIRECTORY_MODE, type QuarantineObserver, quarantineDocument } from "./quarantine"

const SCHEMA_VERSION = 1
const FILE_MODE = 0o600
const LOCK_ACQUIRE_ATTEMPTS = 50

interface IssueGrantTombstone {
    readonly authorizationId: string
    readonly authorizationRevision: number
    readonly reason: Parameters<IssueGrantPort["clear"]>[0]
    readonly createdAt: number
    readonly naturalExpiresAt: number
}

interface IssueGrantDocument {
    readonly grant?: AtomicIssueGrant
    readonly tombstone?: IssueGrantTombstone
}

export interface IssueGrantRepositoryOptions {
    readonly clock?: () => number
    readonly onQuarantine?: QuarantineObserver
}

/**
 * Owner-only atomic issue-token projection; authorization state remains outside this repository.
 *
 * Reads never take the lock. Writers publish through `writeJsonAtomic`, so a reader
 * sees either the previous document or the next one, never a partial file. Every
 * mutation re-reads and re-validates under the lock, which lets several extension
 * hosts share one data directory without contending on a lock for unchanged work.
 */
export class IssueGrantRepository implements IssueGrantPort {
    private readonly lock = new FileLock({ maxAcquireAttempts: LOCK_ACQUIRE_ATTEMPTS })
    private readonly clock: () => number
    private readonly onQuarantine: QuarantineObserver | undefined

    constructor(
        private readonly layout: OtelStorageLayout,
        options: IssueGrantRepositoryOptions = {},
    ) {
        this.clock = options.clock ?? Date.now
        this.onQuarantine = options.onQuarantine
    }

    async publish(grant: AtomicIssueGrant): Promise<void> {
        const validated = validateAtomicIssueGrant(grant)
        // An unchanged grant is already durable, so acquiring the lock would only
        // queue this host behind others for a write it is not going to make. The
        // stored copy is still only equal, not necessarily live: a generation whose
        // window closed while it sat on disk must not be reported as published.
        const snapshot = await this.read()
        if (snapshot.grant && sameAtomicIssueGrant(snapshot.grant, validated) && isGrantLive(validated, this.clock())) return
        await this.withLock(async () => {
            // Re-check under the lock: waiting for another writer can outlast the window.
            assertGrantLive(validated, this.clock())
            const current = await this.readForWrite()
            if (blocksGrant(current.tombstone, validated)) {
                throw new Error("Refusing to republish a revoked issue grant revision")
            }
            if (current.grant && sameAtomicIssueGrant(current.grant, validated)) return
            await this.write({
                grant: validated,
                ...(current.tombstone && current.tombstone.authorizationRevision >= validated.authorizationRevision
                    ? { tombstone: current.tombstone }
                    : {}),
            })
        })
    }

    async readActive(now: number, authorizationRevision: number): Promise<AtomicIssueGrant | null> {
        if (!isTimestamp(now) || !Number.isSafeInteger(authorizationRevision) || authorizationRevision <= 0) {
            throw new Error("Issue grant read identity is invalid")
        }
        const current = await this.read()
        const grant = current.grant
        if (
            !grant ||
            grant.authorizationRevision !== authorizationRevision ||
            !isGrantLive(grant, now) ||
            blocksGrant(current.tombstone, grant)
        ) {
            return null
        }
        return grant
    }

    /** Coordinate short issue-queue writes with revocation across extension hosts; never hold this across network I/O. */
    async withActiveGrant<T>(expected: AtomicIssueGrant, now: number, operation: () => Promise<T>): Promise<T | undefined> {
        return this.withLock(async () => {
            const current = await this.readForWrite()
            const grant = current.grant
            if (
                !grant ||
                !sameAtomicIssueGrant(grant, expected) ||
                !isGrantLive(grant, now) ||
                blocksGrant(current.tombstone, grant)
            ) {
                return undefined
            }
            return operation()
        })
    }

    /**
     * Revoke whatever grant the data directory holds.
     *
     * This always takes the lock and always reads for write. A lock-free reader treats
     * every I/O and parse failure as "no document", so it cannot distinguish a missing
     * grant from one it failed to read; reporting `EACCES` or `EIO` as a completed
     * revocation would let the caller destroy the outbox and the token while a live
     * grant survives. The unlocked read also loses the ordering against a publisher:
     * a first publish that has written its temporary file but not yet renamed leaves
     * no target, so a lock-free clear would return before that grant became visible and
     * leave it unrevoked. Only `ENOENT` is tolerated, which `readForWrite` already does.
     */
    async clear(reason: Parameters<IssueGrantPort["clear"]>[0]): Promise<void> {
        await this.withLock(async () => {
            const current = await this.readForWrite()
            const basis = current.grant ?? tombstoneBasis(current.tombstone)
            if (!basis) return
            const tombstone: IssueGrantTombstone = {
                authorizationId: basis.authorizationId,
                authorizationRevision: basis.authorizationRevision,
                reason,
                createdAt: this.clock(),
                naturalExpiresAt: basis.captureExpiresAt,
            }
            await this.write({ tombstone })
        })
    }

    /** Remove a tombstone only after its credential could no longer be useful even if a receipt survived. */
    async pruneNaturalExpiry(now: number): Promise<void> {
        if (!isTimestamp(now)) throw new Error("Issue grant prune time is invalid")
        // A tombstone that is absent or still inside its capture expiry has nothing to prune.
        const snapshot = await this.read()
        if (!snapshot.tombstone || snapshot.tombstone.naturalExpiresAt > now) return
        await this.withLock(async () => {
            const current = await this.readForWrite()
            if (!current.tombstone || current.tombstone.naturalExpiresAt > now) return
            await fs.rm(this.layout.issueGrantPath, { force: true })
        })
    }

    private async withLock<T>(operation: () => Promise<T>): Promise<T> {
        await fs.mkdir(this.layout.secretsDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
        return this.lock.withLock(this.layout.issueGrantPath, operation)
    }

    private async read(): Promise<IssueGrantDocument> {
        try {
            return parseDocument(JSON.parse(await fs.readFile(this.layout.issueGrantPath, "utf8")))
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
            return {}
        }
    }

    private async readForWrite(): Promise<IssueGrantDocument> {
        let raw: string
        try {
            raw = await fs.readFile(this.layout.issueGrantPath, "utf8")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}
            throw error
        }
        try {
            return parseDocument(JSON.parse(raw))
        } catch {
            if (await quarantineDocument(this.layout.issueGrantPath, this.layout.secretsQuarantineDir, this.clock())) {
                this.onQuarantine?.(path.basename(this.layout.issueGrantPath))
            }
            return {}
        }
    }

    private write(document: IssueGrantDocument): Promise<void> {
        return writeJsonAtomic(this.layout.issueGrantPath, serializeDocument(document), { mode: FILE_MODE, fsync: true })
    }
}

function parseDocument(value: unknown): IssueGrantDocument {
    if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION) throw new Error("Invalid issue grant document")
    const grant = value.grant === undefined ? undefined : parseAtomicIssueGrant({ ok: true, ...asRecord(value.grant) })
    const tombstone = value.tombstone === undefined ? undefined : parseTombstone(value.tombstone)
    if (value.grant !== undefined && !grant) throw new Error("Invalid stored issue grant")
    return { ...(grant ? { grant } : {}), ...(tombstone ? { tombstone } : {}) }
}

function parseTombstone(value: unknown): IssueGrantTombstone {
    if (!isRecord(value)) throw new Error("Invalid issue grant tombstone")
    const authorizationId = value.authorization_id
    const authorizationRevision = value.authorization_revision
    const reason = value.reason
    const createdAt = value.created_at
    const naturalExpiresAt = value.natural_expires_at
    if (
        typeof authorizationId !== "string" ||
        authorizationId.length < 1 ||
        authorizationId.length > 128 ||
        !Number.isSafeInteger(authorizationRevision) ||
        (authorizationRevision as number) <= 0 ||
        !["revoked", "expired", "revision_changed", "deleted"].includes(reason as string) ||
        !isTimestamp(createdAt) ||
        !isTimestamp(naturalExpiresAt)
    ) {
        throw new Error("Invalid issue grant tombstone")
    }
    return {
        authorizationId,
        authorizationRevision: authorizationRevision as number,
        reason: reason as IssueGrantTombstone["reason"],
        createdAt,
        naturalExpiresAt,
    }
}

function serializeDocument(document: IssueGrantDocument): Record<string, unknown> {
    return {
        schema_version: SCHEMA_VERSION,
        ...(document.grant ? { grant: serializeAtomicIssueGrant(document.grant) } : {}),
        ...(document.tombstone
            ? {
                  tombstone: {
                      authorization_id: document.tombstone.authorizationId,
                      authorization_revision: document.tombstone.authorizationRevision,
                      reason: document.tombstone.reason,
                      created_at: document.tombstone.createdAt,
                      natural_expires_at: document.tombstone.naturalExpiresAt,
                  },
              }
            : {}),
    }
}

/**
 * Whether a grant may still be published and used at `now`.
 *
 * `validateAtomicIssueGrant` only checks the shape, so the same value can be
 * structurally valid and long past its window. Publication and activation both
 * need the temporal check, and they must agree on what "expired" means.
 */
function isGrantLive(grant: AtomicIssueGrant, now: number): boolean {
    return grant.expiresAt > now && grant.captureExpiresAt > now
}

/** Refuse a publication whose capture window has already closed. */
function assertGrantLive(grant: AtomicIssueGrant, now: number): void {
    if (!isGrantLive(grant, now)) throw new Error("Refusing to publish an expired issue grant")
}

function blocksGrant(tombstone: IssueGrantTombstone | undefined, grant: AtomicIssueGrant): boolean {
    return Boolean(
        tombstone &&
            tombstone.authorizationId === grant.authorizationId &&
            tombstone.authorizationRevision >= grant.authorizationRevision,
    )
}

function tombstoneBasis(
    tombstone: IssueGrantTombstone | undefined,
): { readonly authorizationId: string; readonly authorizationRevision: number; readonly captureExpiresAt: number } | undefined {
    return tombstone
        ? {
              authorizationId: tombstone.authorizationId,
              authorizationRevision: tombstone.authorizationRevision,
              captureExpiresAt: tombstone.naturalExpiresAt,
          }
        : undefined
}

function asRecord(value: unknown): Record<string, unknown> {
    if (!isRecord(value)) throw new Error("Invalid stored issue grant")
    return value
}

function isTimestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
