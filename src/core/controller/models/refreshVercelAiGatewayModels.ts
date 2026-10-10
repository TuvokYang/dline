import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import { persistProviderCatalog } from "@core/model-registry/provider-catalog-storage"
import { discoverProviderModels } from "@core/model-registry/remote/model-refresh"
import { ModelInfo } from "@shared/api"
import { Logger } from "@/shared/services/Logger"
import { Controller } from ".."

const VERCEL_PROVIDER_ID = "vercel-ai-gateway"

/**
 * Derives recommended temperature for specific model types.
 * Returns undefined to use the default (0).
 */
function _deriveTemperature(modelId: string): number | undefined {
    // DeepSeek R1 and similar reasoning models recommend 0.7
    // Use specific model IDs to match OpenRouter behavior
    if (
        modelId.startsWith("deepseek/deepseek-r1") ||
        modelId === "perplexity/sonar-reasoning" ||
        modelId === "qwen/qwq-32b:free" ||
        modelId === "qwen/qwq-32b"
    ) {
        return 0.7
    }

    // Gemini 3 models recommend temperature 1.0
    if (modelId.startsWith("google/gemini-3")) {
        return 1.0
    }

    return undefined
}

// Track pending refresh promise to prevent duplicate concurrent fetches
let pendingRefresh: Promise<Record<string, ModelInfo>> | null = null

/**
 * Core function: Refreshes Vercel AI Gateway models and returns application types
 * @param controller The controller used to persist models and update the Webview
 * @returns Record of model ID to ModelInfo (application types)
 */
export async function refreshVercelAiGatewayModels(controller: Controller): Promise<Record<string, ModelInfo>> {
    // If a fetch is already in progress, return the same promise
    if (pendingRefresh) {
        return pendingRefresh
    }

    // Start new fetch and track the promise
    pendingRefresh = (async () => {
        try {
            return await fetchAndCacheModels(controller)
        } finally {
            // Clear pending promise when done (success or error)
            pendingRefresh = null
        }
    })()

    return pendingRefresh
}

async function fetchAndCacheModels(controller: Controller): Promise<Record<string, ModelInfo>> {
    let models: Record<string, ModelInfo> = {}

    try {
        const discovered = await discoverProviderModels(VERCEL_PROVIDER_ID)

        if (Object.keys(discovered).length > 0) {
            models = discovered
        } else {
            throw new Error("Invalid response from Vercel AI Gateway API")
        }
    } catch (error) {
        Logger.error("Error fetching Vercel AI Gateway models:", error)

        // If we failed to fetch models, try to read cached models
        const cachedModels = await readPersistedVercelProviderModels()
        if (cachedModels) {
            models = cachedModels
        }
    }

    if (Object.keys(models).length > 0) {
        await persistVercelProviderModels(controller, models)
        Logger.log("Vercel AI Gateway models fetched and saved")
    }

    return models
}

async function readPersistedVercelProviderModels(): Promise<Record<string, ModelInfo> | undefined> {
    const registry = ModelRegistry.getInstance()
    await registry.waitForDeferredProviders()
    const models = registry.getProviderModels(VERCEL_PROVIDER_ID)?.models
    return models && Object.keys(models).length > 0 ? models : undefined
}

/** Persist the dynamic catalog where ModelRegistry and provider editors preload it. */
export async function persistVercelProviderModels(controller: Controller, models: Record<string, ModelInfo>): Promise<void> {
    await persistProviderCatalog({
        providerId: VERCEL_PROVIDER_ID,
        providerName: "Vercel AI Gateway",
        baseUrl: "https://ai-gateway.vercel.sh/v1",
        billingMode: "token",
        models,
    })
    await controller.postStateToWebview()
}
