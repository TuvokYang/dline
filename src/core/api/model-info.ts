import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import type { ModelInfo } from "@shared/api"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"

/**
 * Resolve effective model metadata for a profile using the runtime registry.
 *
 * @param profile ApiProfile containing provider, model selection, and overrides.
 * @returns Effective model metadata merged from registry and provider overrides.
 */
export function getProfileModelInfo(profile: ApiProfile): ModelInfo {
    const providerModels = ModelRegistry.getInstance().getProviderModels(profile.provider)
    return resolveProfileModelInfo(profile, providerModels) as ModelInfo
}
