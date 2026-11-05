import { resolveSavedCredentials } from "@core/model-registry/remote/model-credentials"
import { discoverProviderModels } from "@core/model-registry/remote/model-refresh"
import * as SecretsManager from "@core/storage/secrets"
import { StringArray } from "@shared/proto/dline/common"
import { ProviderModelsRequest } from "@shared/proto/dline/models"
import { getProviderCatalog } from "@shared/providers/model-infos"
import { Logger } from "@shared/services/Logger"
import { Controller } from ".."

/**
 * Catalogs whose discovery result is written to disk.
 *
 * OpenCode publishes every limit, cache flag and thinking level the settings
 * page needs, but the catalog that page reads is built from local declarations,
 * so a preview-only listing would leave those facts unreachable. Other providers
 * keep the preview behaviour: their listings either omit metadata or already
 * have a persisted writer.
 */
const PERSISTED_DISCOVERY_PROVIDER_IDS: ReadonlySet<string> = new Set(["opencode"])

/**
 * List the model ids a provider currently exposes.
 *
 * The settings form calls this while the user is still editing a profile, so
 * unsaved credentials travel with the request.
 *
 * @param request Provider id plus the optional base URL and API key in the form
 * @returns Array of model ids, empty when the provider cannot be listed
 */
export async function refreshProviderModels(controller: Controller, request: ProviderModelsRequest): Promise<StringArray> {
    if (!request.providerId) {
        Logger.debug("[ModelDiscovery] Dropdown refresh skipped: provider is missing")
        return StringArray.create({ values: [] })
    }

    const providerId = request.providerId
    const startedAt = Date.now()
    const profileScoped = Boolean(request.profileId)
    const codex = providerId === "openai-codex"
    Logger.debug(
        `[ModelDiscovery] Dropdown refresh started provider=${providerId} profileScoped=${profileScoped} baseUrl=${request.baseUrl ? "custom" : "default"}`,
    )

    try {
        // The form omits a field it does not own: the API key lives in secrets and
        // never reaches the profile object the picker reads. Merging per field
        // keeps an edited base URL from discarding the stored key, and vice versa.
        // Profile-scoped providers receive only the non-sensitive Profile identity;
        // their source owns credential resolution and refresh.
        const saved = request.profileId
            ? { apiKey: SecretsManager.getApiKey(request.profileId), baseUrl: undefined }
            : resolveSavedCredentials(providerId)
        const ownerId = getProviderCatalog(providerId)?.provider.provider ?? providerId
        const persist = PERSISTED_DISCOVERY_PROVIDER_IDS.has(ownerId)
        const models = await discoverProviderModels(
            providerId,
            {
                profileId: request.profileId || undefined,
                baseUrl: request.baseUrl || saved.baseUrl,
                apiKey: request.apiKey || saved.apiKey,
            },
            // A listing carrier persists what it discovers so the catalog the
            // settings page actually reads can answer with the vendor's limits
            // and capabilities. Other providers keep the preview-only behaviour.
            { persist, throwOnError: codex },
        )
        // A persisted catalog is what the settings page reads its limits and
        // capabilities from, so the write has to reach the Webview. The writer
        // refreshes the registry entry without publishing, and the file watcher's
        // publication is debounced behind its stability window; posting here
        // makes the refreshed catalog visible as soon as this call returns.
        if (persist && Object.keys(models).length > 0) {
            await controller.postStateToWebview()
        }
        const values = Object.keys(models)
        Logger.debug(
            `[ModelDiscovery] Dropdown refresh completed provider=${providerId} profileScoped=${profileScoped} models=${values.length} modelIds=${values.join(",") || "none"} durationMs=${Date.now() - startedAt}`,
        )
        return StringArray.create({ values })
    } catch (error) {
        Logger.warn(
            `[ModelDiscovery] Dropdown refresh failed provider=${providerId} profileScoped=${profileScoped} durationMs=${Date.now() - startedAt} error=${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
        )
        throw error
    }
}
