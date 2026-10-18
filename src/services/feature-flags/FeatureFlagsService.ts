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
 * Reads are synchronous and resolve lazily into a snapshot, so repeated reads
 * agree with each other even if a source changes underneath. The snapshot
 * moves only through {@link refresh}, which the rollout source triggers when
 * its answers change; listeners then learn of the change and re-project it.
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
    private readonly listeners = new Set<() => void>()

    /**
     * Re-resolve the switches and tell listeners when any of them changed.
     *
     * Called when a source's answers change, or to pick up an environment
     * change within a running session.
     */
    public refresh(): void {
        const previous = this.snapshot
        this.snapshot = undefined
        if (!previous || this.listeners.size === 0) return
        const next = this.resolveSnapshot()
        if (EXPERIMENTAL_FEATURE_FLAGS.some((flag) => previous.get(flag) !== next.get(flag))) {
            for (const listener of this.listeners) listener()
        }
    }

    /** Called after {@link refresh} changed a switch; returns the unsubscribe function. */
    public onDidChange(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
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

    public getAccountEnabled(): boolean {
        return this.getBooleanFlagEnabled(ExperimentalFeatureFlag.ACCOUNT)
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
        this.listeners.clear()
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
