/**
 * Nous Research provider model definitions.
 * Extracted from api.ts nousResearchModels (lines 5063-5084).
 */
import type { ModelInfo } from "@shared/api"

export const nousResearchModels: Record<string, ModelInfo> = {
    "Hermes-4-405B": {
        id: "Hermes-4-405B",
        name: "Hermes-4-405B",
        description:
            "This is the largest model in the Hermes 4 family, and it is the fullest expression of our design, focused on advanced reasoning and creative depth rather than optimizing inference speed or cost.",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.09,
            outputPrice: 0.37,
        },
    },
    "Hermes-4-70B": {
        id: "Hermes-4-70B",
        name: "Hermes-4-70B",
        description:
            "This incarnation of Hermes 4 balances scale and size. It handles complex reasoning tasks, while staying fast and cost effective. A versatile choice for many use cases.",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.05,
            outputPrice: 0.2,
        },
    },
}

/** Default model ID for Nous Research provider */
export const nousResearchDefaultModelId = "Hermes-4-405B"
