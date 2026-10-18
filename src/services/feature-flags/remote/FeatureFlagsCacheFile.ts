import { rm } from "node:fs/promises"
import { backupPathOf, readJsonWithBackup, writeJsonAtomic } from "@shared/storage/atomic-file"
import { FEATURE_FLAGS_SCHEMA_VERSION, type FeatureFlagsDocument, parseFeatureFlagsDocument } from "./flagsDocument"

/** The last answers of the feature service and when they were fetched. */
export interface CachedFeatureFlags {
    readonly document: FeatureFlagsDocument
    /** Epoch milliseconds of the fetch, so another window can tell whether the answers are due. */
    readonly fetchedAt: number
}

/** Keeps the last answers across restarts and shares them between windows. */
export interface FeatureFlagsCache {
    read(): Promise<CachedFeatureFlags | undefined>
    write(entry: CachedFeatureFlags): Promise<void>
    /** Forget the answers, so no window applies them again. */
    clear(): Promise<void>
}

/**
 * A cache document in the resource home's cache directory.
 *
 * The file is a copy of what the service said, not an authority: an unreadable
 * or foreign document reads as absent, and the next fetch replaces it.
 */
export class FeatureFlagsCacheFile implements FeatureFlagsCache {
    constructor(private readonly filePath: string) {}

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
        await Promise.all([rm(this.filePath, { force: true }), rm(backupPathOf(this.filePath), { force: true })])
    }
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
