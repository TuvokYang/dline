/**
 * Unified model access layer.
 * Imports from individual provider model files via models/index.ts.
 * Used by seed-initializer.ts for JSON export to ~/.dline/providers/.
 */

import { allProviderModels } from "../../core/api/providers/models/index"
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
        return { provider: direct, catalog: direct }
    }
    for (const provider of Object.values(allProviderModels)) {
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

/** Every catalog key a provider claims, including its own id. */
export function getProviderCatalogKeys(provider: ProviderModelsConfig): string[] {
    return [provider.provider, ...Object.keys(provider.catalogs ?? {})]
}
