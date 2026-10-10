import {
    EXPERIMENTAL_FEATURE_FLAGS,
    ExperimentalFeatureFlag,
    ExperimentalFeatureFlagDefaultValue,
} from "@/shared/services/feature-flags/feature-flags"
import { Logger } from "@/shared/services/Logger"
import type { FeatureFlagPayload, IFeatureFlagsProvider } from "./providers/IFeatureFlagsProvider"

/**
 * Answers which experimental capabilities are switched on.
 *
 * The switches were once fetched from a remote flag service, so reads were
 * served from a cache that a `poll()` on the sign-in path filled — a caller on
 * a hot path could not await a request. That also meant the switches only ever
 * resolved for signed-in users.
 *
 * Resolution is local now, so reads resolve on demand and fill the snapshot
 * lazily. The snapshot is kept so that repeated reads within a session agree
 * with each other even if the environment changes underneath.
 *
 * Deliberately independent of telemetry consent and of the account: a
 * capability must not depend on whether the user is measured or signed in.
 */
export class FeatureFlagsService {
    /**
     * Constructor that accepts an IFeatureFlagsProvider instance
     * @param provider IFeatureFlagsProvider instance for retrieving feature flags
     */
    public constructor(private provider: IFeatureFlagsProvider) {}

    private snapshot: Map<ExperimentalFeatureFlag, FeatureFlagPayload> | undefined

    /**
     * Discard the snapshot so the next read re-resolves.
     *
     * Reads resolve on their own, so this is only needed to pick up an
     * environment change within a running session.
     */
    public refresh(): void {
        this.snapshot = undefined
    }

    public getBooleanFlagEnabled(flagName: ExperimentalFeatureFlag): boolean {
        return this.resolveSnapshot().get(flagName) === true
    }

    public getFlagPayload(flagName: ExperimentalFeatureFlag): FeatureFlagPayload | undefined {
        return this.resolveSnapshot().get(flagName)
    }

    public getWebtoolsEnabled(): boolean {
        return this.getBooleanFlagEnabled(ExperimentalFeatureFlag.WEBTOOLS)
    }

    public getWorktreesEnabled(): boolean {
        return this.getBooleanFlagEnabled(ExperimentalFeatureFlag.WORKTREES)
    }

    /**
     * Get the feature flags provider instance
     * @returns The current feature flags provider
     */
    public getProvider(): IFeatureFlagsProvider {
        return this.provider
    }

    /**
     * Check if feature flags are currently enabled
     * @returns Boolean indicating whether feature flags are enabled
     */
    public isEnabled(): boolean {
        return this.provider.isEnabled()
    }

    /**
     * Get current feature flags settings
     * @returns Current feature flags settings
     */
    public getSettings() {
        return this.provider.getSettings()
    }

    /**
     * For testing: directly set a feature flag in the snapshot
     */
    public test(flagName: ExperimentalFeatureFlag, value: boolean) {
        if (process.env.NODE_ENV === "true") {
            this.resolveSnapshot().set(flagName, value)
        }
    }

    /**
     * Clean up resources when the service is disposed
     */
    public async dispose(): Promise<void> {
        this.snapshot = undefined
        await this.provider.dispose()
    }

    /**
     * Resolve every switch once per session.
     *
     * A provider failure leaves the switches at their static defaults rather
     * than propagating: a capability toggle must not break the caller that
     * merely asked about it.
     */
    private resolveSnapshot(): Map<ExperimentalFeatureFlag, FeatureFlagPayload> {
        if (this.snapshot) {
            return this.snapshot
        }

        const snapshot = new Map<ExperimentalFeatureFlag, FeatureFlagPayload>()
        for (const flag of EXPERIMENTAL_FEATURE_FLAGS) {
            snapshot.set(flag, ExperimentalFeatureFlagDefaultValue[flag] ?? false)
        }

        try {
            const resolved = this.provider.resolveFlags(EXPERIMENTAL_FEATURE_FLAGS)
            for (const flag of EXPERIMENTAL_FEATURE_FLAGS) {
                const value = resolved[flag]
                if (value !== undefined) {
                    snapshot.set(flag, value)
                }
            }
        } catch (error) {
            Logger.error("Error resolving experimental feature flags; using defaults:", error)
        }

        this.snapshot = snapshot
        return snapshot
    }
}
