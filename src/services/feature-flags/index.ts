export {
    type FeatureFlagsProviderConfig,
    FeatureFlagsProviderFactory,
    type FeatureFlagsProviderType,
} from "./FeatureFlagsProviderFactory"
export { FeatureFlagsService } from "./FeatureFlagsService"
export type { FeatureFlagsSettings, IFeatureFlagsProvider } from "./providers/IFeatureFlagsProvider"
export { LayeredFeatureFlagsProvider } from "./providers/LayeredFeatureFlagsProvider"
export { LocalFeatureFlagsProvider } from "./providers/LocalFeatureFlagsProvider"
export { RemoteFeatureFlagsProvider } from "./providers/RemoteFeatureFlagsProvider"

import { REMOTE_ROLLOUT_FEATURE_FLAGS } from "@/shared/services/feature-flags/feature-flags"
import { FeatureFlagsProviderFactory } from "./FeatureFlagsProviderFactory"
import { FeatureFlagsService } from "./FeatureFlagsService"
import { LayeredFeatureFlagsProvider } from "./providers/LayeredFeatureFlagsProvider"
import { RemoteFeatureFlagsProvider } from "./providers/RemoteFeatureFlagsProvider"
import { type RemoteFeatureFlagsRuntimeOptions, startRemoteFeatureFlags } from "./remote/remoteFeatureFlagsRuntime"

let _featureFlagsServiceInstance: FeatureFlagsService | null = null
let _rolloutProvider: RemoteFeatureFlagsProvider | null = null

/**
 * Get the singleton feature flags service instance.
 *
 * Local overrides answer first; the rollout service answers only the switches
 * no local source sets, and the static defaults decide the rest.
 */
export function getFeatureFlagsService(): FeatureFlagsService {
    if (!_featureFlagsServiceInstance) {
        const local = FeatureFlagsProviderFactory.createProvider(FeatureFlagsProviderFactory.getDefaultConfig())
        const rollout = getRolloutProvider()
        const service = new FeatureFlagsService(new LayeredFeatureFlagsProvider([local, rollout]))
        rollout.onDidChange(() => service.refresh())
        _featureFlagsServiceInstance = service
    }
    return _featureFlagsServiceInstance
}

/**
 * Start fetching rollout answers from the Dline feature service. Resolves once
 * the cached answers are applied; later answers arrive through
 * {@link FeatureFlagsService.onDidChange}.
 */
export function startFeatureFlagRollout(options: Omit<RemoteFeatureFlagsRuntimeOptions, "provider" | "flags">): Promise<void> {
    getFeatureFlagsService()
    return startRemoteFeatureFlags({ ...options, provider: getRolloutProvider(), flags: REMOTE_ROLLOUT_FEATURE_FLAGS })
}

function getRolloutProvider(): RemoteFeatureFlagsProvider {
    _rolloutProvider ??= new RemoteFeatureFlagsProvider(REMOTE_ROLLOUT_FEATURE_FLAGS)
    return _rolloutProvider
}

/**
 * Reset the feature flags service instance (useful for testing)
 */
export function resetFeatureFlagsService(): void {
    void _rolloutProvider?.dispose()
    _rolloutProvider = null
    _featureFlagsServiceInstance = null
}

export const featureFlagsService = new Proxy({} as FeatureFlagsService, {
    get(_target, prop, _receiver) {
        const service = getFeatureFlagsService()
        const value = Reflect.get(service, prop, service)
        // Bind methods to the service instance to preserve `this` context
        if (typeof value === "function") {
            return value.bind(service)
        }
        return value
    },
})
