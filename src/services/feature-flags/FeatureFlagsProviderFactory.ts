import type { FeatureFlagPayload, IFeatureFlagsProvider } from "./providers/IFeatureFlagsProvider"
import { LocalFeatureFlagsProvider } from "./providers/LocalFeatureFlagsProvider"

/**
 * Supported feature flags provider types.
 *
 * The PostHog-backed provider was removed with the remote flags it served:
 * asking an upstream service which capabilities this extension may use is not a
 * dependency Dline keeps. `local` resolves the remaining experimental switches
 * from the environment; `no-op` leaves every switch at its static default and
 * exists for tests and for hosts that want no environment influence at all.
 */
export type FeatureFlagsProviderType = "local" | "no-op"

/**
 * Configuration for feature flags providers
 */
export interface FeatureFlagsProviderConfig {
    type: FeatureFlagsProviderType
}

/**
 * Factory class for creating feature flags providers
 */
export class FeatureFlagsProviderFactory {
    /**
     * Creates a feature flags provider based on the provided configuration
     * @param config Configuration for the feature flags provider
     * @returns IFeatureFlagsProvider instance
     */
    public static createProvider(config: FeatureFlagsProviderConfig): IFeatureFlagsProvider {
        switch (config.type) {
            case "local":
                return new LocalFeatureFlagsProvider()
            default:
                return new NoOpFeatureFlagsProvider()
        }
    }

    /**
     * Gets the default feature flags provider configuration.
     *
     * Resolution is local and makes no network call, so the same configuration
     * applies to every deployment, self-hosted included.
     */
    public static getDefaultConfig(): FeatureFlagsProviderConfig {
        return { type: "local" }
    }
}

/**
 * No-operation feature flags provider.
 *
 * Returns no values, which leaves each switch at its static default.
 */
class NoOpFeatureFlagsProvider implements IFeatureFlagsProvider {
    resolveFlags(_flagKeys: readonly string[]): Record<string, FeatureFlagPayload> {
        return {}
    }

    public isEnabled(): boolean {
        return true
    }

    public getSettings() {
        return { enabled: true }
    }

    public async dispose(): Promise<void> {
        // Nothing is held open.
    }
}
