import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import type { ModelInfo } from "@shared/api"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { resolveProfileCatalogKey, resolveProfileModelInfo } from "@shared/providers/profile-model-info"

/**
 * Resolve effective model metadata for a profile using the runtime registry.
 *
 * @param profile ApiProfile containing provider, model selection, and overrides.
 * @returns Effective model metadata merged from registry and provider overrides.
 */
export function getProfileModelInfo(profile: ApiProfile): ModelInfo {
    // Resolve the catalog the Profile actually reads. A Profile stores one
    // provider identity, so asking for the provider alone would answer with the
    // primary catalog even when a mode or region selects a different one.
    const providerModels = ModelRegistry.getInstance().getProviderCatalog(resolveProfileCatalogKey(profile))
    return resolveProfileModelInfo(profile, providerModels) as ModelInfo
}
