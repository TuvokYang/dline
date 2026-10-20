/**
 * DeepSeek provider model definitions.
 * Extracted from api.ts deepSeekModels (lines 2213-2238).
 */
import type { ModelInfo } from "@shared/api"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"

export const DEEPSEEK_REASONING_EFFORT_OPTIONS = ["low", "high", "max"] as const

/** Declared thinking capability for the seeded DeepSeek models. */
function thinkingCapabilities() {
    return {
        supported: true,
        mode: "effort",
        effortLevels: [...DEEPSEEK_REASONING_EFFORT_OPTIONS],
        defaultEnabled: true,
        canDisable: true,
        defaultEffort: "high",
    }
}

/**
 * Hosted Web Search declaration per model.
 *
 * The declaration is the only authority the routing plan reads, and a hosted route
 * withholds the local `web_search` tool. Declaring search for a model the provider
 * cannot run it on therefore removes both routes at once.
 *
 * DeepSeek documents hosted search for `deepseek-v4-pro` only: in the Responses API
 * `web_search` is "supported with deepseek-v4-pro ... ignored with deepseek-flash".
 * The Anthropic-compatible surface rejects the declaration outright. Flash keeps no
 * declaration so Auto mode falls back to Dline's local search executor, and Chat
 * Completions carries no hosted search for either model.
 * @see https://api-docs.deepseek.com/guides/responses_api
 */
export const deepSeekModels: Record<string, ModelInfo> = {
    "deepseek-v4-pro": {
        id: "deepseek-v4-pro",
        name: "deepseek-v4-pro",
        capabilities: {
            supportsTools: true,
            maxTokens: 384_000,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: true,
            supportsReasoning: true,
            thinking: thinkingCapabilities(),
            tools: [ServerTool.WEB_SEARCH],
        },
        apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT],
        pricing: {
            inputPrice: 3,
            outputPrice: 6,
            cacheWritesPrice: 3,
            cacheReadsPrice: 0.025,
            currency: "CNY",
        },
    },
    "deepseek-flash": {
        id: "deepseek-flash",
        name: "deepseek-flash",
        capabilities: {
            supportsTools: true,
            maxTokens: 384_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            thinking: thinkingCapabilities(),
            // No hosted tools: `web_search` is ignored for this model, so declaring it
            // would route Auto to a hosted search that never runs and hide the local one.
        },
        apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT],
        pricing: {
            inputPrice: 1,
            outputPrice: 2,
            cacheWritesPrice: 1,
            cacheReadsPrice: 0.02,
            currency: "CNY",
        },
    },
}

/** Default model ID for DeepSeek provider */
export const deepSeekDefaultModelId = "deepseek-flash"
