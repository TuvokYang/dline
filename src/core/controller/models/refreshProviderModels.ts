import { resolveSavedCredentials } from "@core/model-registry/remote/model-credentials"
import { discoverProviderModels } from "@core/model-registry/remote/model-refresh"
import * as SecretsManager from "@core/storage/secrets"
import { StringArray } from "@shared/proto/dline/common"
import { ProviderModelsRequest } from "@shared/proto/dline/models"
import { Logger } from "@shared/services/Logger"
import { Controller } from ".."

/**
 * List the model ids a provider currently exposes.
 *
 * The settings form calls this while the user is still editing a profile, so
 * unsaved credentials travel with the request. The result is never persisted —
 * it only feeds the model picker alongside the local catalog.
 *
 * @param request Provider id plus the optional base URL and API key in the form
 * @returns Array of model ids, empty when the provider cannot be listed
 */
export async function refreshProviderModels(_controller: Controller, request: ProviderModelsRequest): Promise<StringArray> {
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
        const models = await discoverProviderModels(
            providerId,
            {
                profileId: request.profileId || undefined,
                baseUrl: request.baseUrl || saved.baseUrl,
                apiKey: request.apiKey || saved.apiKey,
            },
            { throwOnError: codex },
        )
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
