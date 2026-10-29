import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { backupPathOf, readJsonWithBackup, writeJsonAtomic } from "@shared/storage/atomic-file"
import { FileLock } from "@/core/storage/backend/jsonl/FileLock"
import { FEATURE_FLAGS_SCHEMA_VERSION, type FeatureFlagsDocument, parseFeatureFlagsDocument } from "./flagsDocument"

/**
 * How long a claimed request may take before another window stops waiting for
 * its answer; above the request timeout, so a window that is still asking is
 * not mistaken for one that gave up.
 */
export const FEATURES_REQUEST_SETTLE_MS = 15_000

/** The last answers of the feature service and when they were fetched. */
export interface CachedFeatureFlags {
    readonly document: FeatureFlagsDocument
    /** Epoch milliseconds of the fetch, so another window can tell whether the answers are due. */
    readonly fetchedAt: number
}

/** The outcome of asking for the machine's next rollout request. */
export type FeatureFlagsRequestClaim =
    /** This window asks now and sends this id with the request. */
    | { readonly granted: true; readonly requestId: string }
    /** Another window asked recently or holds fresh answers; look at the shared cache again at `recheckAt`. */
    | { readonly granted: false; readonly recheckAt: number }

/** Keeps the last answers across restarts and shares them between windows. */
export interface FeatureFlagsCache {
    read(): Promise<CachedFeatureFlags | undefined>
    write(entry: CachedFeatureFlags): Promise<void>
    /** Forget the answers, so no window applies them again. */
    clear(): Promise<void>
    /**
     * Claim the one request the machine may make per interval, across every
     * window and whatever the outcome, so windows starting together or a failing
     * service never multiply requests.
     */
    claimRequest(now: number, intervalMs: number): Promise<FeatureFlagsRequestClaim>
}

/** The machine-wide record of the last claimed request. */
interface RequestGate {
    readonly claimedAt: number
    readonly requestId: string
}

/**
 * A cache document in the resource home's cache directory.
 *
 * The file is a copy of what the service said, not an authority: an unreadable
 * or foreign document reads as absent, and the next fetch replaces it.
 */
export class FeatureFlagsCacheFile implements FeatureFlagsCache {
    private readonly gatePath: string
    private readonly lock = new FileLock()

    constructor(private readonly filePath: string) {
        this.gatePath = path.join(path.dirname(filePath), `${path.basename(filePath, ".json")}.request.json`)
    }

    async read(): Promise<CachedFeatureFlags | undefined> {
        const result = await readJsonWithBackup(this.filePath, parseCachedFeatureFlags)
        return result.status === "primary" || result.status === "backup" ? result.value : undefined
    }

    async write(entry: CachedFeatureFlags): Promise<void> {
        await writeJsonAtomic(this.filePath, {
            schema_version: FEATURE_FLAGS_SCHEMA_VERSION,
            flags: entry.document.flags,
            ttl_seconds: entry.document.ttlSeconds,
            fetched_at: entry.fetchedAt,
        })
    }

    async clear(): Promise<void> {
        // The backup goes too: a read falls back to it when the primary is missing.
        // The request gate stays: forgetting answers must not allow an extra request.
        await Promise.all([rm(this.filePath, { force: true }), rm(backupPathOf(this.filePath), { force: true })])
    }

    async claimRequest(now: number, intervalMs: number): Promise<FeatureFlagsRequestClaim> {
        await mkdir(path.dirname(this.gatePath), { recursive: true })
        return this.lock.withLock(this.gatePath, async () => {
            const cached = await this.read()
            if (cached && isWithinInterval(cached.fetchedAt, now, intervalMs)) {
                return { granted: false, recheckAt: cached.fetchedAt + intervalMs }
            }
            const gate = await this.readGate()
            if (gate && isWithinInterval(gate.claimedAt, now, intervalMs)) {
                // While the claimer may still be asking, look again soon to pick up its answer.
                const settledAt = gate.claimedAt + FEATURES_REQUEST_SETTLE_MS
                return { granted: false, recheckAt: now < settledAt ? settledAt : gate.claimedAt + intervalMs }
            }
            const requestId = randomUUID()
            await writeJsonAtomic(this.gatePath, { claimed_at: now, request_id: requestId })
            return { granted: true, requestId }
        })
    }

    private async readGate(): Promise<RequestGate | undefined> {
        const result = await readJsonWithBackup(this.gatePath, parseRequestGate)
        return result.status === "primary" || result.status === "backup" ? result.value : undefined
    }
}

/**
 * Whether `at` lies within one interval before `now`. A time in the future
 * means the clock moved back, and is treated as long past so a clock change
 * cannot block requests for longer than one interval.
 */
function isWithinInterval(at: number, now: number, intervalMs: number): boolean {
    return at <= now && now - at < intervalMs
}

function parseRequestGate(value: unknown): RequestGate {
    const record = value as { claimed_at?: unknown; request_id?: unknown } | null
    if (typeof record?.claimed_at !== "number" || !Number.isFinite(record.claimed_at) || typeof record.request_id !== "string") {
        throw new Error("Not a feature flags request gate")
    }
    return { claimedAt: record.claimed_at, requestId: record.request_id }
}

/** Throws for anything that is not a cache document, as `readJsonWithBackup` requires. */
function parseCachedFeatureFlags(value: unknown): CachedFeatureFlags {
    const document = parseFeatureFlagsDocument(value)
    const fetchedAt = (value as { fetched_at?: unknown } | null)?.fetched_at
    if (!document || typeof fetchedAt !== "number" || !Number.isFinite(fetchedAt)) {
        throw new Error("Not a feature flags cache document")
    }
    return { document, fetchedAt }
}
