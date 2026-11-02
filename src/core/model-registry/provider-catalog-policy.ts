import { allProviderModels } from "@core/api/providers/models"
import { getProviderCatalog } from "@shared/providers/model-infos"

/**
 * Whether a stored model entry comes from a vendor listing rather than a user.
 *
 * Persisted discovery marks its entries `userDefined: false`; an entry a person
 * added carries `true`, and an entry this build wrote before the marker existed
 * carries nothing and is treated as an older built-in.
 */
export function isListingDerivedModel(model: { userDefined?: boolean } | undefined): boolean {
    return model?.userDefined !== true
}

/**
 * Catalogs that are not billed by the prices the listing declares.
 *
 * `opencode-go` is a subscription plan whose models are published by the shared
 * OpenCode listing. That listing attaches the per-token prices the same model
 * costs on a pay-as-you-go gateway, which the plan never charges, so a model the
 * plan surfaces without a seed entry must not inherit them. Pay-as-you-go
 * catalogues (`opencode`, `qwen-cn`, `zai-cn`) keep the declared prices.
 */
const PLAN_BILLED_CATALOG_IDS: ReadonlySet<string> = new Set(["opencode-go"])

export function isListingOwnedPlanCatalog(catalogKey: string): boolean {
    return PLAN_BILLED_CATALOG_IDS.has(catalogKey)
}

/**
 * Providers whose catalog is loaded after the blocking startup pass. The set is
 * derived from the seed data so that marking a catalog `deferred` in one place
 * is enough.
 */
export const DEFERRED_PROVIDER_IDS: ReadonlySet<string> = new Set(
    Object.values(allProviderModels)
        .filter((config) => config.deferred === true)
        .map((config) => config.provider),
)

export function isDeferredProvider(providerId: string): boolean {
    return DEFERRED_PROVIDER_IDS.has(providerId)
}

/**
 * Whether a provider id names an alternative catalog of another provider.
 *
 * Only the provider entry is selectable. An id that resolves to another entry's
 * catalog is a leftover from the build that registered the catalog as a
 * provider, so it must be ignored rather than loaded.
 */
export function isAlternativeCatalogKey(providerId: string): boolean {
    const selection = getProviderCatalog(providerId)
    return selection !== undefined && selection.provider.provider !== providerId
}
