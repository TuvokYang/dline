/**
 * The single entry point for pulling a model catalog from a vendor.
 *
 * Discovery is demand-driven: the settings form calls it while the user is
 * still typing, and profile creation calls it with `persist` so the result
 * lands in ~/.dline/providers/<id>.json. Nothing refreshes on startup.
 */
import { resolvePrimaryCatalogKey } from "@shared/providers/provider-catalog-key"
import type { ModelInfo } from "@shared/providers/types"
import { Logger } from "@shared/services/Logger"
import { ModelRegistry } from "../ModelRegistry"
import { persistProviderCatalog } from "../provider-catalog-storage"
import { resolveSavedCredentials } from "./model-credentials"
import type { ProviderRemoteContext } from "./model-source"
import { getModelSource } from "./vendors"

export interface DiscoverProviderModelsOptions {
    /** Write the result to the provider catalog and reload the registry entry. */
    readonly persist?: boolean
    readonly signal?: AbortSignal
    /** Preserve the provider error for callers that must distinguish failure from an empty catalog. */
    readonly throwOnError?: boolean
}

const MODEL_CATALOG_TTL_MS = 30 * 60 * 1000
interface CatalogFetch {
    fetchedAt: number
    request: Promise<Record<string, ModelInfo>>
}
/** Fetch state follows the registry lifetime and is never written into provider configuration. */
const catalogFetches = new WeakMap<ModelRegistry, Map<string, CatalogFetch>>()

export async function discoverProviderModels(
    providerId: string,
    credentials?: ProviderRemoteContext,
    options?: DiscoverProviderModelsOptions,
): Promise<Record<string, ModelInfo>> {
    const source = getModelSource(providerId)
    if (!source) {
        return {}
    }

    const resolved = credentials ?? resolveSavedCredentials(providerId)
    if (source.requiresApiKey && !resolved.apiKey) {
        return {}
    }

    const catalogKey = resolvePrimaryCatalogKey(providerId)
    const registry = ModelRegistry.getInstance()
    let cache = catalogFetches.get(registry)
    if (!cache) {
        cache = new Map()
        catalogFetches.set(registry, cache)
    }
    // Connection identity separates private catalogs; persistence is not a network identity.
    const key = JSON.stringify([catalogKey, resolved.profileId, resolved.baseUrl, resolved.apiKey, resolved.vendorCredentials])
    try {
        let fetched = cache.get(key)
        const now = Date.now()
        if (!fetched || now - fetched.fetchedAt >= MODEL_CATALOG_TTL_MS) {
            fetched = {
                fetchedAt: now,
                request: source.fetchModels({ ...resolved, catalogKey, signal: options?.signal }),
            }
            cache.set(key, fetched)
        }
        const models = await fetched.request
        if (options?.persist === true && Object.keys(models).length > 0) {
            await persistProviderCatalog({
                providerId: catalogKey,
                providerName: source.providerName,
                baseUrl: resolved.baseUrl,
                billingMode: source.billingMode,
                models,
                preferredDefaultModelId: source.preferredDefaultModelId,
                reconciliationMode: source.reconciliation,
            })
        }
        return models
    } catch (error) {
        Logger.warn(`[${providerId}] Model discovery failed: ${error instanceof Error ? error.message : String(error)}`)
        if (options?.throwOnError) throw error
        return {}
    }
}
