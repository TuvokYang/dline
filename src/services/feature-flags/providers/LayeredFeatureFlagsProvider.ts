import type { FeatureFlagPayload, FeatureFlagsSettings, IFeatureFlagsProvider } from "./IFeatureFlagsProvider"

/**
 * Asks providers in precedence order; the first one with an opinion on a
 * switch decides it. A failing layer is skipped rather than failing the read,
 * so a broken remote layer cannot hide the local overrides.
 */
export class LayeredFeatureFlagsProvider implements IFeatureFlagsProvider {
    constructor(private readonly layers: readonly IFeatureFlagsProvider[]) {}

    resolveFlags(flagKeys: readonly string[]): Record<string, FeatureFlagPayload> {
        const resolved: Record<string, FeatureFlagPayload> = {}
        for (const layer of this.layers) {
            let answers: Record<string, FeatureFlagPayload>
            try {
                answers = layer.resolveFlags(flagKeys)
            } catch {
                continue
            }
            for (const [key, value] of Object.entries(answers)) {
                if (!Object.hasOwn(resolved, key)) resolved[key] = value
            }
        }
        return resolved
    }

    isEnabled(): boolean {
        return this.layers.some((layer) => layer.isEnabled())
    }

    getSettings(): FeatureFlagsSettings {
        return { enabled: this.isEnabled() }
    }

    async dispose(): Promise<void> {
        await Promise.all(this.layers.map((layer) => layer.dispose()))
    }
}
