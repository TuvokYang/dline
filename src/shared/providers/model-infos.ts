/**
 * Unified model access layer.
 * Imports from individual provider model files via models/index.ts.
 * Used by seed-initializer.ts for JSON export to ~/.dline/providers/.
 */

import { allProviderModels } from "../../core/api/providers/models/index"
import { resolvePrimaryCatalogKey } from "./provider-catalog-key"
import type { ProviderCatalog, ProviderModelsConfig } from "./types"

export { allProviderModels }

export function getProviderSeedConfig(providerId: string): ProviderModelsConfig | undefined {
    return allProviderModels[providerId]
}

export function getSeedProviderIds(): string[] {
    return Object.keys(allProviderModels)
}

/**
 * Resolve one catalog by its catalog key.
 *
 * A catalog key is either a selectable provider id, whose entry owns the primary
 * catalog, or the key of one of that provider's alternative catalogs. Resolving
 * here keeps "which models does this key answer with" in one place, so a handler,
 * the registry and the settings UI cannot disagree.
 *
 * @param catalogKey Key produced by `resolveCatalogProviderKey`.
 * @returns The provider entry and the catalog it selects, or undefined.
 */
export function getProviderCatalog(catalogKey: string): ProviderCatalogSelection | undefined {
    const direct = allProviderModels[catalogKey]
    if (direct) {
        // A provider whose primary catalog is not keyed by its own id answers with
        // that catalog, so a caller holding only the provider id reaches the models
        // the provider publishes first.
        const primaryKey = resolvePrimaryCatalogKey(catalogKey)
        const primary = primaryKey === catalogKey ? undefined : direct.catalogs?.[primaryKey]
        return { provider: direct, catalog: primary ?? direct }
    }
    for (const provider of Object.values(allProviderModels)) {
        // The primary catalog of such a provider is stored at the top level, not in
        // `catalogs`, so the key has to be resolved before giving up: otherwise the
        // primary catalog would be the one catalog nobody can look up by its key.
        if (resolvePrimaryCatalogKey(provider.provider) === catalogKey) {
            return { provider, catalog: provider }
        }
        const catalog = provider.catalogs?.[catalogKey]
        if (catalog) {
            return { provider, catalog }
        }
    }
    return undefined
}

/** The provider entry and the one catalog a key selects. */
export interface ProviderCatalogSelection {
    readonly provider: ProviderModelsConfig
    readonly catalog: ProviderCatalog
}

/**
 * Every catalog key a provider claims, primary first.
 *
 * A provider whose primary catalog is not keyed by its own id contributes that
 * primary key rather than its id: the id is a selectable identity, not a stored
 * catalog, and listing it would advertise a catalog no document supplies. Keys
 * are de-duplicated because a provider may declare its primary key in `catalogs`
 * and the provider id as well.
 */
export function getProviderCatalogKeys(provider: ProviderModelsConfig): string[] {
    const primaryKey = resolvePrimaryCatalogKey(provider.provider)
    const keys = [primaryKey, ...Object.keys(provider.catalogs ?? {})]
    return [...new Set(keys)]
}
