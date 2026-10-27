import fs from "node:fs/promises"
import path from "node:path"
import { writeJsonAtomic } from "@shared/storage/atomic-file"
import { validateUsageAttemptObservation } from "@/services/telemetry/remote/usage/attemptBucket"
import type { UsageAttemptObservation } from "@/services/telemetry/remote/usage/attemptProjection"
import type { OtelStorageLayout } from "./OtelStorageLayout"
import { type QuarantineObserver, quarantineDocument } from "./quarantine"
import { LOCAL_SESSION_ID_PATTERN } from "./UsageObservationSpool"

export const USAGE_ATTEMPT_FINALIZATION_SCHEMA_VERSION = 1
const SHARD_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/
const DOCUMENT_SUFFIX = ".json"

/** One terminal attempt still inside its token finalization window. */
export interface PendingAttemptFinalization {
    readonly observationId: string
    /** Wall-clock deadline after which the attempt is final with its highest accepted revision. */
    readonly deadline: number
    readonly revision: number
    readonly localSessionId: string
    readonly observation: UsageAttemptObservation
}

/** Pending attempts of one shard whose owner did not finalize them in time. */
export interface OverdueAttemptFinalizations {
    readonly shard: string
    readonly entries: readonly PendingAttemptFinalization[]
}

export interface UsageAttemptFinalizationStoreOptions {
    readonly clock?: () => number
    readonly onQuarantine?: QuarantineObserver
}

/**
 * Durable token finalization deadlines under `telemetry/remote/usage/finalization`.
 *
 * Each extension host rewrites only its own shard document. Another host reads
 * a foreign shard solely to recover entries whose deadline passed long enough
 * ago that their owner can no longer be finalizing them, then removes exactly
 * those entries. Recovery may duplicate an emission in a race; the fold's
 * per-attempt revision checkpoint absorbs it.
 */
export class UsageAttemptFinalizationStore {
    private readonly directory: string
    private readonly quarantineDirectory: string
    private readonly clock: () => number
    private writes: Promise<void> = Promise.resolve()

    constructor(
        layout: OtelStorageLayout,
        private readonly shardId: string,
        private readonly options: UsageAttemptFinalizationStoreOptions = {},
    ) {
        if (!SHARD_NAME_PATTERN.test(shardId)) throw new Error("Usage finalization shard id must be a short file-safe token")
        this.directory = layout.usageFinalizationDir
        this.quarantineDirectory = layout.remoteQuarantineDir
        this.clock = options.clock ?? Date.now
    }

    /** Replace this shard's pending set; an empty set removes the document. Writes apply in call order. */
    save(entries: readonly PendingAttemptFinalization[]): Promise<void> {
        const snapshot = entries.map(validatePending)
        const write = this.writes.then(() => this.writeShard(this.shardId, snapshot))
        this.writes = write.catch(() => undefined)
        return write
    }

    /** Foreign-shard entries whose deadline plus `graceMs` has passed at `now`. */
    async readOverdue(now: number, graceMs: number): Promise<OverdueAttemptFinalizations[]> {
        const overdue: OverdueAttemptFinalizations[] = []
        for (const shard of await this.listShards()) {
            if (shard === this.shardId) continue
            const entries = (await this.readShard(shard)).filter((entry) => entry.deadline + graceMs <= now)
            if (entries.length > 0) overdue.push({ shard, entries })
        }
        return overdue
    }

    /** Remove recovered entries from a foreign shard, keeping anything its owner added since. */
    async removeRecovered(shard: string, observationIds: readonly string[]): Promise<void> {
        if (!SHARD_NAME_PATTERN.test(shard) || shard === this.shardId) return
        const recovered = new Set(observationIds)
        const remaining = (await this.readShard(shard)).filter((entry) => !recovered.has(entry.observationId))
        await this.writeShard(shard, remaining)
    }

    /** Delete every pending deadline, for example when the user turns usage reporting off. */
    async purge(): Promise<void> {
        await this.writes
        await fs.rm(this.directory, { recursive: true, force: true })
    }

    private async writeShard(shard: string, entries: readonly PendingAttemptFinalization[]): Promise<void> {
        const filePath = this.shardPath(shard)
        if (entries.length === 0) {
            await fs.rm(filePath, { force: true })
            return
        }
        await fs.mkdir(this.directory, { recursive: true })
        await writeJsonAtomic(filePath, {
            schema_version: USAGE_ATTEMPT_FINALIZATION_SCHEMA_VERSION,
            pending: entries.map((entry) => ({
                observation_id: entry.observationId,
                deadline: entry.deadline,
                revision: entry.revision,
                local_session_id: entry.localSessionId,
                observation: entry.observation,
            })),
        })
    }

    private async readShard(shard: string): Promise<PendingAttemptFinalization[]> {
        const filePath = this.shardPath(shard)
        let raw: string
        try {
            raw = await fs.readFile(filePath, "utf8")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
            throw error
        }
        const parsed = parseDocument(raw)
        if (parsed) return parsed
        if (await quarantineDocument(filePath, this.quarantineDirectory, this.clock())) {
            this.options.onQuarantine?.(path.basename(filePath))
        }
        return []
    }

    private async listShards(): Promise<string[]> {
        const names = await fs.readdir(this.directory).catch(() => [] as string[])
        return names
            .filter((name) => name.endsWith(DOCUMENT_SUFFIX))
            .map((name) => name.slice(0, -DOCUMENT_SUFFIX.length))
            .filter((shard) => SHARD_NAME_PATTERN.test(shard))
            .sort()
    }

    private shardPath(shard: string): string {
        return path.join(this.directory, `${shard}${DOCUMENT_SUFFIX}`)
    }
}

function validatePending(entry: PendingAttemptFinalization): PendingAttemptFinalization {
    if (!entry.observationId || entry.observation.attemptObservationId !== entry.observationId) {
        throw new Error("Pending finalization identity does not match its observation")
    }
    if (!Number.isSafeInteger(entry.deadline) || entry.deadline < 0) throw new Error("Pending finalization deadline is invalid")
    if (!Number.isSafeInteger(entry.revision) || entry.revision < 0) throw new Error("Pending finalization revision is invalid")
    if (!LOCAL_SESSION_ID_PATTERN.test(entry.localSessionId)) throw new Error("Pending finalization session is invalid")
    validateUsageAttemptObservation(entry.observation)
    return entry
}

function parseDocument(raw: string): PendingAttemptFinalization[] | undefined {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        return undefined
    }
    if (typeof value !== "object" || value === null) return undefined
    const document = value as Record<string, unknown>
    if (document.schema_version !== USAGE_ATTEMPT_FINALIZATION_SCHEMA_VERSION || !Array.isArray(document.pending)) {
        return undefined
    }
    const entries: PendingAttemptFinalization[] = []
    for (const item of document.pending) {
        if (typeof item !== "object" || item === null) return undefined
        const record = item as Record<string, unknown>
        try {
            entries.push(
                validatePending({
                    observationId: record.observation_id as string,
                    deadline: record.deadline as number,
                    revision: record.revision as number,
                    localSessionId: record.local_session_id as string,
                    observation: record.observation as UsageAttemptObservation,
                }),
            )
        } catch {
            return undefined
        }
    }
    return entries
}
