import { allProviderModels } from "@core/api/providers/models"

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
