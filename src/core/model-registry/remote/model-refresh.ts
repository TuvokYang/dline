/**
 * The single entry point for pulling a model catalog from a vendor.
 *
 * Discovery is demand-driven: the settings form calls it while the user is
 * still typing, and profile creation calls it with `persist` so the result
 * lands in ~/.dline/providers/<id>.json. Nothing refreshes on startup.
 */
import type { ModelInfo } from "@shared/providers/types"
import { Logger } from "@shared/services/Logger"
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

/** Concurrent callers for one provider share a single request. */
const inFlight = new Map<string, Promise<Record<string, ModelInfo>>>()

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

    // Only requests that share the provider, the catalog and the persistence
    // intent are interchangeable: a preview must not satisfy a caller expecting
    // a write, and a Console refresh must not satisfy a Go refresh, which reads a
    // different listing.
    const key = `${providerId}:${resolved.profileId ?? "default"}:${options?.persist === true ? "persist" : "preview"}`
    const pending = inFlight.get(key)
    if (pending) {
        return pending
    }

    const request = (async () => {
        try {
            // The provider id *is* the catalog key here: `providerId` is what the
            // caller asked to refresh, and a plan-aware source uses it to pick the
            // listing that answers for that plan. Passing only the resolved
            // credentials is what made every plan read the Console listing.
            const models = await source.fetchModels({ ...resolved, catalogKey: providerId, signal: options?.signal })
            if (options?.persist === true && Object.keys(models).length > 0) {
                await persistProviderCatalog({
                    // The catalog key the caller asked for, not the source's own
                    // provider id: a Go Profile reads `opencode-go`, and writing
                    // that result under `opencode` would leave the Go catalog on
                    // its local declarations.
                    providerId,
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
        } finally {
            inFlight.delete(key)
        }
    })()

    inFlight.set(key, request)
    return request
}
