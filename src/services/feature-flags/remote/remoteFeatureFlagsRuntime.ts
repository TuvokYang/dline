import path from "node:path"
import type { RemoteFeatureFlagsProvider } from "../providers/RemoteFeatureFlagsProvider"
import { FeatureFlagsCacheFile } from "./FeatureFlagsCacheFile"
import { FeatureFlagsHttpSource } from "./FeatureFlagsHttpSource"

export const FEATURE_FLAGS_CACHE_FILE_NAME = "feature-flags.json"

/**
 * How the rollout names this device. It rides on usage reporting: the cohort
 * is the device the usage service issued, so a rollout can be measured by the
 * usage of the devices it reached, and a device that does not report usage
 * takes no part.
 */
export interface FeatureFlagsIdentity {
    /** Whether the device reports usage now; local and synchronous. */
    readonly participates: () => boolean
    /** The device id the usage service issued, or `undefined` before enrollment. */
    readonly deviceId: (signal?: AbortSignal) => Promise<string | undefined>
}

export interface RemoteFeatureFlagsRuntimeOptions {
    readonly provider: RemoteFeatureFlagsProvider
    /** The resource home's cache directory; the answers are a cache, not settings. */
    readonly cacheDir: string
    readonly identity: FeatureFlagsIdentity
    readonly version: string
    readonly platform: string
    readonly flags: readonly string[]
    readonly endpoint?: string
    readonly log?: (level: "debug" | "warn", message: string) => void
}

/** Point the rollout provider at the Dline feature service and its shared cache. */
export function startRemoteFeatureFlags(options: RemoteFeatureFlagsRuntimeOptions): Promise<void> {
    const source = new FeatureFlagsHttpSource({
        endpoint: options.endpoint,
        deviceId: options.identity.deviceId,
        query: {
            version: options.version,
            platform: options.platform,
            flags: options.flags,
        },
    })
    options.log?.("debug", `[FeatureFlags] Rollout answers come from ${source.origin}`)
    return options.provider.start({
        source,
        cache: new FeatureFlagsCacheFile(path.join(options.cacheDir, FEATURE_FLAGS_CACHE_FILE_NAME)),
        participates: options.identity.participates,
        log: options.log,
    })
}
