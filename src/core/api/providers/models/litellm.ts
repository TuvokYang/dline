/**
 * LiteLLM provider constants.
 */

import type { ModelInfo } from "@shared/api"

/** LiteLLM-specific model info with optional temperature */
export interface LiteLLMModelInfo extends ModelInfo {
    temperature?: number
}

/** Default ModelInfo for LiteLLM provider */
export const liteLlmModelInfoSaneDefaults: LiteLLMModelInfo = {
    id: "",
    capabilities: {
        supportsImages: true,
        supportsPromptCache: true,
        supportsReasoning: false,
        maxTokens: -1,
        contextWindow: 128_000,
    },
    pricing: {
        inputPrice: 0,
        outputPrice: 0,
        cacheWritesPrice: 0,
        cacheReadsPrice: 0,
    },
    temperature: 0,
}

/** Default model ID for LiteLLM provider */
export const liteLlmDefaultModelId = "anthropic/claude-3-7-sonnet-20250219"
