/**
 * Requesty provider constants.
 */

import type { ModelInfo } from "@shared/api"
import { flatPricing } from "./pricing"

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
    pricing: flatPricing(3.0, 15.0, 3.75, 0.3),
}
