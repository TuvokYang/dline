import path from "node:path"
import { isReportingAllowed, type TelemetrySetting } from "@shared/TelemetrySetting"
import type { FeatureFlagsLogLevel, RemoteFeatureFlagsProvider } from "../providers/RemoteFeatureFlagsProvider"
import { FeatureFlagsCacheFile } from "./FeatureFlagsCacheFile"
import { FeatureFlagsHttpSource } from "./FeatureFlagsHttpSource"

export const FEATURE_FLAGS_CACHE_FILE_NAME = "feature-flags.json"

/**
 * Whether the device takes part in the rollout channel.
 *
 * A rollout is judged by what the devices it reached report: their usage
 * measures it, their errors show what it broke. A device that withholds either
 * report cannot be judged, so it takes no part, and its stored answers go.
 */
export function rolloutChannelOpen(usageReportingAllowed: boolean, errorReporting: TelemetrySetting): boolean {
    return usageReportingAllowed && isReportingAllowed(errorReporting)
}

/**
 * How the rollout names this device. It rides on usage reporting: the cohort
 * is the device the usage service issued, so a rollout can be measured by the
 * usage of the devices it reached.
 */
export interface FeatureFlagsIdentity {
    /** Whether the rollout channel is open now, see {@link rolloutChannelOpen}; local and synchronous. */
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
    /** Pace of the rollout requests; `rolloutPollIntervalMs` chooses it per build. */
    readonly pollIntervalMs: number
    readonly endpoint?: string
    readonly log?: (level: FeatureFlagsLogLevel, message: string) => void
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
        pollIntervalMs: options.pollIntervalMs,
        log: options.log,
    })
}
