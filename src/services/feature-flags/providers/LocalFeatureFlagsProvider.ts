import { resolveExperimentalFlags } from "@/shared/services/feature-flags/resolve-experimental-flags"
import type { FeatureFlagPayload, FeatureFlagsSettings, IFeatureFlagsProvider } from "./IFeatureFlagsProvider"

/**
 * Answers the experimental switches from the local environment.
 *
 * This replaces the remote flag service. Resolution happens per call rather
 * than at construction so a variable changed in a reloaded development host
 * takes effect on the next read without restarting the extension.
 */
export class LocalFeatureFlagsProvider implements IFeatureFlagsProvider {
    constructor(private readonly env: Readonly<Record<string, string | undefined>> = process.env) {}

    resolveFlags(flagKeys: readonly string[]): Record<string, FeatureFlagPayload> {
        const resolved = resolveExperimentalFlags(this.env)
        const requested = new Set(flagKeys)
        const flags: Record<string, FeatureFlagPayload> = {}

        for (const [flag, enabled] of Object.entries(resolved)) {
            if (requested.has(flag)) {
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
