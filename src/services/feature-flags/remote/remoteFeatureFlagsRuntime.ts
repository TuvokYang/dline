import { createHash } from "node:crypto"
import path from "node:path"
import type { RemoteFeatureFlagsProvider } from "../providers/RemoteFeatureFlagsProvider"
import { FeatureFlagsCacheFile } from "./FeatureFlagsCacheFile"
import { FeatureFlagsHttpSource } from "./FeatureFlagsHttpSource"

export const FEATURE_FLAGS_CACHE_FILE_NAME = "feature-flags.json"
/** Domain separator of the bucket hash, so the bucket cannot be matched against other hashes of the same identity. */
const BUCKET_DOMAIN = "dline-features:"

export interface RemoteFeatureFlagsRuntimeOptions {
    readonly provider: RemoteFeatureFlagsProvider
    /** The resource home's cache directory; the answers are a cache, not settings. */
    readonly cacheDir: string
    /** Device identity the rollout bucket is derived from; it is never sent as is. */
    readonly distinctId: string
    readonly version: string
    readonly platform: string
    readonly flags: readonly string[]
    readonly endpoint?: string
    readonly log?: (level: "debug" | "warn", message: string) => void
}

/**
 * Stable rollout bucket of one installation.
 *
 * One-way and domain-separated, so the service can keep a device in the same
 * cohort across requests without learning an identity it could join with
 * telemetry.
 */
export function featureFlagsBucket(distinctId: string): string {
    return createHash("sha256").update(`${BUCKET_DOMAIN}${distinctId}`).digest("hex")
}

/** Point the rollout provider at the Dline feature service and its shared cache. */
export function startRemoteFeatureFlags(options: RemoteFeatureFlagsRuntimeOptions): Promise<void> {
    const source = new FeatureFlagsHttpSource({
        endpoint: options.endpoint,
        query: {
            bucket: featureFlagsBucket(options.distinctId),
            version: options.version,
            platform: options.platform,
            flags: options.flags,
        },
    })
    options.log?.("debug", `[FeatureFlags] Rollout answers come from ${source.origin}`)
    return options.provider.start({
        source,
        cache: new FeatureFlagsCacheFile(path.join(options.cacheDir, FEATURE_FLAGS_CACHE_FILE_NAME)),
        log: options.log,
    })
}
