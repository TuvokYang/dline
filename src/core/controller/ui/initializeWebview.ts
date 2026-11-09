import { findEnabledProfiles } from "@core/controller/file/getApiProfiles"
import { isProviderCatalogStale } from "@core/model-registry/provider-catalog-freshness"
import { getProfileCatalogRepository } from "@core/profiles/profile-catalog-runtime"
import * as SecretsManager from "@core/storage/secrets"
import { Empty, EmptyRequest } from "@shared/proto/dline/common"
import { OpenRouterCompatibleModelInfo } from "@shared/proto/dline/models"
import { toProtobufModelInfo } from "@shared/proto-conversions/models/typeConversion"
import { readMcpMarketplaceCatalogFromCache } from "@/core/storage/disk"
import { getTelemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../index"
import { sendMcpMarketplaceCatalogEvent } from "../mcp/subscribeToMcpMarketplaceCatalog"
import { refreshBasetenModels } from "../models/refreshBasetenModels"
import { refreshClineModels } from "../models/refreshClineModels"
import { refreshGroqModels } from "../models/refreshGroqModels"
import { refreshHicapModels } from "../models/refreshHicapModels"
import { refreshLiteLlmModels } from "../models/refreshLiteLlmModels"
import { refreshOpenRouterModels } from "../models/refreshOpenRouterModels"
import { sendOpenRouterModelsEvent } from "../models/subscribeToOpenRouterModels"

/** OpenRouter lists its catalog publicly, so its identity is not profile-scoped. */
const OPENROUTER_PROVIDER_ID = "openrouter"

/**
 * Initialize webview when it launches
 * @param controller The controller instance
 * @param request The empty request
 * @returns Empty response
 */
export async function initializeWebview(controller: Controller, _request: EmptyRequest): Promise<Empty> {
    try {
        // Start cross-process Catalog reconciliation even when this window only reads Profiles.
        await getProfileCatalogRepository()

        // Load the persisted OpenRouter catalog in the background so Webview initialization never waits for a large JSON file.
        void controller
            .readOpenRouterModels()
            .then((lastCachedModels) => {
                if (!lastCachedModels) return
                const models = Object.fromEntries(
                    Object.entries(lastCachedModels).map(([modelId, modelInfo]) => [modelId, toProtobufModelInfo(modelInfo)]),
                )
                void sendOpenRouterModelsEvent(OpenRouterCompatibleModelInfo.create({ models }))
            })
            .catch((error) => Logger.error("Failed to load cached OpenRouter models:", error))

        // Refresh OpenRouter models only when the stored catalog has gone stale.
        // The listing is public, so it works without credentials, but that is not
        // a reason to pull it on every Webview mount: this handler runs again each
        // time the panel returns to the welcome view, and an unconditional request
        // there rewrites a multi-hundred-kilobyte file and republishes state.
        void isProviderCatalogStale(OPENROUTER_PROVIDER_ID).then((stale) => {
            if (!stale) return
            return refreshOpenRouterModels(controller).catch((error) =>
                Logger.error("Failed to refresh OpenRouter models:", error),
            )
        })

        // Only refresh provider-specific models if the corresponding credentials are configured.
        // This avoids unnecessary network requests for unauthenticated users or providers
        // without configured API keys.
        // Each provider check looks for any enabled profile with a valid apiKey.

        // Cline models require authentication
        if (findEnabledProfiles("cline").some((p) => SecretsManager.getApiKey(p.id))) {
            refreshClineModels(controller)
        }

        // Groq models require an API key
        if (findEnabledProfiles("groq").some((p) => SecretsManager.getApiKey(p.id))) {
            refreshGroqModels(controller)
        }

        // Baseten models require an API key
        if (findEnabledProfiles("baseten").some((p) => SecretsManager.getApiKey(p.id))) {
            refreshBasetenModels(controller)
        }

        // Hicap models require an API key
        if (findEnabledProfiles("hicap").some((p) => SecretsManager.getApiKey(p.id))) {
            refreshHicapModels(controller, EmptyRequest.create())
        }

        // LiteLLM requires both base URL and API key
        const liteLlmBaseUrl = controller.stateManager.getGlobalSettingsKey("liteLlmBaseUrl")
        const hasLiteLlmKey = findEnabledProfiles("litellm").some((p) => SecretsManager.getApiKey(p.id))
        if (liteLlmBaseUrl && hasLiteLlmKey) {
            await refreshLiteLlmModels()
        }

        // Send stored MCP marketplace catalog if available
        const mcpMarketplaceCatalog = await readMcpMarketplaceCatalogFromCache()
        if (mcpMarketplaceCatalog) {
            sendMcpMarketplaceCatalogEvent(controller, mcpMarketplaceCatalog)
        }

        // Silently refresh MCP marketplace catalog
        controller.refreshMcpMarketplace(true /* sendCatalogEvent */)

        // Ensure providers and host identity are attached now that the webview is live.
        // Usage reporting is on by default, so a host that turned telemetry off is
        // respected silently here; only an explicit opt-in warns about it.
        void getTelemetryService()

        return Empty.create({})
    } catch (error) {
        Logger.error("Failed to initialize webview:", error)
        return Empty.create({})
    }
}
