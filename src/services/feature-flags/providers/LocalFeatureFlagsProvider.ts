import { EXPERIMENTAL_FEATURE_FLAGS } from "@/shared/services/feature-flags/feature-flags"
import { isDevelopmentBuild, resolveLocalExperimentalFlag } from "@/shared/services/feature-flags/resolve-experimental-flags"
import type { FeatureFlagPayload, FeatureFlagsSettings, IFeatureFlagsProvider } from "./IFeatureFlagsProvider"

/**
 * Answers the experimental switches from the local environment and the build.
 *
 * A switch no local source sets is omitted, so a later provider or the static
 * default decides it. Resolution happens per call rather than at construction
 * so a variable changed in a reloaded development host takes effect on the
 * next read without restarting the extension.
 */
export class LocalFeatureFlagsProvider implements IFeatureFlagsProvider {
    constructor(
        private readonly env: Readonly<Record<string, string | undefined>> = process.env,
        private readonly developmentBuild: boolean = isDevelopmentBuild(),
    ) {}

    resolveFlags(flagKeys: readonly string[]): Record<string, FeatureFlagPayload> {
        const requested = new Set(flagKeys)
        const flags: Record<string, FeatureFlagPayload> = {}

        for (const flag of EXPERIMENTAL_FEATURE_FLAGS) {
            if (!requested.has(flag)) continue
            const enabled = resolveLocalExperimentalFlag(flag, this.env, this.developmentBuild)
            if (enabled !== undefined) {
                flags[flag] = enabled
            }
        }

        return flags
    }

    public isEnabled(): boolean {
        return true
    }

    public getSettings(): FeatureFlagsSettings {
        // No request is made, so no timeout applies.
        return { enabled: true }
    }

    public async dispose(): Promise<void> {
        // Nothing is held open.
    }
}
