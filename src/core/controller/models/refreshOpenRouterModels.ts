import { persistProviderCatalog } from "@core/model-registry/provider-catalog-storage"
import { discoverProviderModels } from "@core/model-registry/remote/model-refresh"
import { type ModelInfo, openRouterDefaultModelId } from "@shared/api"
import { GEMINI_FLASH_MAX_OUTPUT_TOKENS, isGeminiFlashModel } from "@utils/model-utils"
import cloneDeep from "clone-deep"
import {
    CLAUDE_OPUS_1M_TIERS,
    CLAUDE_SONNET_1M_TIERS,
    openRouterClaudeOpus461mModelId,
    openRouterClaudeOpus471mModelId,
    openRouterClaudeSonnet41mModelId,
    openRouterClaudeSonnet451mModelId,
    openRouterClaudeSonnet461mModelId,
} from "@/shared/api"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from ".."

const OPENROUTER_PROVIDER_ID = "openrouter"

// Track pending refresh promise to prevent duplicate concurrent fetches
let pendingRefresh: Promise<Record<string, ModelInfo>> | null = null

/**
 * Core function: Refreshes the OpenRouter models and returns application types
 * @param controller The controller instance
 * @returns Record of model ID to ModelInfo (application types)
 */
export async function refreshOpenRouterModels(controller: Controller): Promise<Record<string, ModelInfo>> {
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
        const discovered = await discoverProviderModels(OPENROUTER_PROVIDER_ID)

        if (Object.keys(discovered).length > 0) {
            for (const [modelId, listedModel] of Object.entries(discovered)) {
                // The listing is authoritative; the corrections below only add what it cannot express.
                const modelInfo = cloneDeep(listedModel)

                switch (modelId) {
                    case "anthropic/claude-sonnet-4.6":
                    case "anthropic/claude-4.6-sonnet":
                    case "anthropic/claude-sonnet-4.5":
                    case "anthropic/claude-4.5-sonnet":
                    case "anthropic/claude-sonnet-4":
                        // NOTE: we artificially restrict the context window to 200k to keep costs low for users, and have a :1m model variant created below for users that want to use the full 1m.
                        modelInfo.capabilities!.contextWindow = 200_000
                        modelInfo.capabilities!.supportsPromptCache = true
                        modelInfo.pricing!.cacheWritesPrice = 3.75
                        modelInfo.pricing!.cacheReadsPrice = 0.3
                        break
                    case "anthropic/claude-3-7-sonnet":
                    case "anthropic/claude-3-7-sonnet:beta":
                    case "anthropic/claude-3.7-sonnet":
                    case "anthropic/claude-3.7-sonnet:beta":
                    case "anthropic/claude-3.7-sonnet:thinking":
                    case "anthropic/claude-3.5-sonnet":
                    case "anthropic/claude-3.5-sonnet:beta":
                        // NOTE: this needs to be synced with api.ts/openrouter default model info
                        modelInfo.capabilities!.supportsPromptCache = true
                        modelInfo.pricing!.cacheWritesPrice = 3.75
                        modelInfo.pricing!.cacheReadsPrice = 0.3
                        break
                    case "anthropic/claude-opus-4.6":
                    case "anthropic/claude-opus-4.7":
                        modelInfo.capabilities!.contextWindow = 200_000 // restrict to 200k, 1m variant created below
                        modelInfo.capabilities!.supportsPromptCache = true
                        modelInfo.pricing!.cacheWritesPrice = 6.25
                        modelInfo.pricing!.cacheReadsPrice = 0.5
                        break
                    case "anthropic/claude-opus-4.5":
                        modelInfo.capabilities!.supportsPromptCache = true
                        modelInfo.pricing!.cacheWritesPrice = 6.25
                        modelInfo.pricing!.cacheReadsPrice = 0.5
                        break
                    case "anthropic/claude-opus-4.1":
                    case "anthropic/claude-opus-4":
                        modelInfo.capabilities!.supportsPromptCache = true
                        modelInfo.pricing!.cacheWritesPrice = 18.75
                        modelInfo.pricing!.cacheReadsPrice = 1.5
                        break
                    case "anthropic/claude-3.5-sonnet-20240620":
                    case "anthropic/claude-3.5-sonnet-20240620:beta":
                        modelInfo.capabilities!.supportsPromptCache = true
                        modelInfo.pricing!.cacheWritesPrice = 3.75
                        modelInfo.pricing!.cacheReadsPrice = 0.3
                        break
                    case "anthropic/claude-haiku-4.5":
                    case "anthropic/claude-4.5-haiku":
                    case "anthropic/claude-3-5-haiku":
                    case "anthropic/claude-3-5-haiku:beta":
                    case "anthropic/claude-3-5-haiku-20241022":
                    case "anthropic/claude-3-5-haiku-20241022:beta":
                    case "anthropic/claude-3.5-haiku":
                    case "anthropic/claude-3.5-haiku:beta":
                    case "anthropic/claude-3.5-haiku-20241022":
                    case "anthropic/claude-3.5-haiku-20241022:beta":
                        modelInfo.capabilities!.supportsPromptCache = true
                        modelInfo.pricing!.cacheWritesPrice = 1.25
                        modelInfo.pricing!.cacheReadsPrice = 0.1
                        break
                    case "anthropic/claude-3-opus":
                    case "anthropic/claude-3-opus:beta":
                        modelInfo.capabilities!.supportsPromptCache = true
                        modelInfo.pricing!.cacheWritesPrice = 18.75
                        modelInfo.pricing!.cacheReadsPrice = 1.5
                        break
                    case "anthropic/claude-3-haiku":
                    case "anthropic/claude-3-haiku:beta":
                        modelInfo.capabilities!.supportsPromptCache = true
                        modelInfo.pricing!.cacheWritesPrice = 0.3
                        modelInfo.pricing!.cacheReadsPrice = 0.03
                        break
                    case "deepseek/deepseek-chat":
                        modelInfo.capabilities!.supportsPromptCache = true
                        // see api.ts/deepSeekModels for more info
                        modelInfo.pricing!.inputPrice = 0
                        modelInfo.pricing!.cacheWritesPrice = 0.14
                        modelInfo.pricing!.cacheReadsPrice = 0.014
                        break
                    case "x-ai/grok-3-beta":
                        modelInfo.capabilities!.supportsPromptCache = true
                        modelInfo.pricing!.cacheWritesPrice = 0.75
                        modelInfo.pricing!.cacheReadsPrice = 0
                        break
                    case "moonshotai/kimi-k2":
                        // forcing kimi-k2 to use the together provider for full context and best throughput
                        modelInfo.pricing!.inputPrice = 1
                        modelInfo.pricing!.outputPrice = 3
                        modelInfo.capabilities!.contextWindow = 131_000
                        break
                    case "openai/gpt-5":
                    case "openai/gpt-5-chat":
                    case "openai/gpt-5-mini":
                    case "openai/gpt-5-nano":
                        modelInfo.capabilities!.maxTokens = 8_192 // 128000 breaks context window truncation
                        modelInfo.capabilities!.contextWindow = 272_000 // openrouter reports 400k but the input limit is actually 400k-128k
                        break
                    case "x-ai/grok-code-fast-1":
                        modelInfo.capabilities!.supportsPromptCache = true
                        modelInfo.pricing!.cacheReadsPrice = 0.02
                        break
                    default:
                        // OpenAI and Google publish their cache prices in the listing, so the
                        // prompt-cache flag follows from whether a cache read price came back.
                        // OpenRouter charges no cache write pricing for OpenAI models.
                        if (modelId.startsWith("openai/") || modelId.startsWith("google/")) {
                            if (modelInfo.pricing?.cacheReadsPrice) {
                                modelInfo.capabilities!.supportsPromptCache = true
                            }
                        }
                        break
                }

                if (isGeminiFlashModel(modelId)) {
                    modelInfo.capabilities!.maxTokens = Math.min(
                        modelInfo.capabilities!.maxTokens || GEMINI_FLASH_MAX_OUTPUT_TOKENS,
                        GEMINI_FLASH_MAX_OUTPUT_TOKENS,
                    )
                }

                models[modelId] = modelInfo

                // add custom :1m model variant for sonnet
                if (
                    modelId === "anthropic/claude-sonnet-4" ||
                    modelId === "anthropic/claude-sonnet-4.5" ||
                    modelId === "anthropic/claude-4.5-sonnet" ||
                    modelId === "anthropic/claude-sonnet-4.6" ||
                    modelId === "anthropic/claude-4.6-sonnet"
                ) {
                    const claudeSonnet1mModelInfo = cloneDeep(modelInfo)
                    claudeSonnet1mModelInfo.capabilities!.contextWindow = 1_000_000 // limiting providers to those that support 1m context window
                    claudeSonnet1mModelInfo.pricing!.tiers = CLAUDE_SONNET_1M_TIERS
                    // sonnet 4
                    if (modelId === "anthropic/claude-sonnet-4") {
                        models[openRouterClaudeSonnet41mModelId] = claudeSonnet1mModelInfo
                    }
                    // sonnet 4.5
                    if (modelId === "anthropic/claude-sonnet-4.5" || modelId === "anthropic/claude-4.5-sonnet") {
                        models[openRouterClaudeSonnet451mModelId] = claudeSonnet1mModelInfo
                    }
                    // sonnet 4.6
                    if (modelId === "anthropic/claude-sonnet-4.6" || modelId === "anthropic/claude-4.6-sonnet") {
                        models[openRouterClaudeSonnet461mModelId] = claudeSonnet1mModelInfo
                    }
                }

                // add custom :1m model variant for opus 4.6 and 4.7
                if (modelId === "anthropic/claude-opus-4.6" || modelId === "anthropic/claude-opus-4.7") {
                    const claudeOpus1mModelInfo = cloneDeep(modelInfo)
                    claudeOpus1mModelInfo.capabilities!.contextWindow = 1_000_000
                    claudeOpus1mModelInfo.pricing!.tiers = CLAUDE_OPUS_1M_TIERS
                    if (modelId === "anthropic/claude-opus-4.6") {
                        models[openRouterClaudeOpus461mModelId] = claudeOpus1mModelInfo
                    }
                    if (modelId === "anthropic/claude-opus-4.7") {
                        models[openRouterClaudeOpus471mModelId] = claudeOpus1mModelInfo
                    }
                }
            }
            await persistOpenRouterProviderModels(controller, models)
            Logger.log("OpenRouter models fetched and saved")
        } else {
            throw new Error("Invalid response data when fetching OpenRouter models")
        }
    } catch (error) {
        Logger.error("Error fetching OpenRouter models:", error)

        // If we failed to fetch models, try to read cached models
        const cachedModels = await controller.readOpenRouterModels()
        if (cachedModels) {
            models = cachedModels
        }
    }

    // Append stealth models if any
    return appendClineStealthModels(models)
}

/** Persist the dynamic catalog where ModelRegistry and provider editors preload it. */
export async function persistOpenRouterProviderModels(controller: Controller, models: Record<string, ModelInfo>): Promise<void> {
    await persistProviderCatalog({
        providerId: OPENROUTER_PROVIDER_ID,
        providerName: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        billingMode: "token",
        models,
        preferredDefaultModelId: openRouterDefaultModelId,
    })
    await controller.postStateToWebview()
}

/**
 * Stealth models are models that are compatible with the OpenRouter API but not listed on the OpenRouter website or API.
 */
const CLINE_STEALTH_MODELS: Record<string, ModelInfo> = {
    "stealth/giga-potato": {
        id: "stealth/giga-potato",
        name: "Giga Potato",
        description: "A stealth model for testing purposes. Not a real potato.",
        capabilities: { maxTokens: 8192, contextWindow: 224_000, supportsImages: true, supportsPromptCache: true },
        pricing: { inputPrice: 0, outputPrice: 0 },
    },
}

export function appendClineStealthModels(currentModels: Record<string, ModelInfo>): Record<string, ModelInfo> {
    // Create a shallow clone of the current models to avoid mutating the original object
    const cloned = { ...currentModels }
    for (const [modelId, modelInfo] of Object.entries(CLINE_STEALTH_MODELS)) {
        if (!cloned[modelId]) {
            cloned[modelId] = modelInfo
        }
    }
    return cloned
}
