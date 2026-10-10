/**
 * Requesty provider constants.
 */

import type { ModelInfo } from "@shared/api"

/** Default model ID for Requesty provider */
export const requestyDefaultModelId = "anthropic/claude-3-7-sonnet-latest"

/** Default ModelInfo for Requesty provider */
export const requestyDefaultModelInfo: ModelInfo = {
    id: "",
    capabilities: {
        supportsImages: true,
        supportsPromptCache: true,
        supportsReasoning: false,
        maxTokens: 64_000,
        contextWindow: 200_000,
    },
    pricing: {
        inputPrice: 3.0,
        outputPrice: 15.0,
        cacheWritesPrice: 3.75,
        cacheReadsPrice: 0.3,
    },
}
