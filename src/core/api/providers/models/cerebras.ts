/**
 * Cerebras provider model definitions.
 * Extracted from api.ts cerebrasModels (lines 3993-4029).
 */
import type { ModelInfo } from "@shared/api"

export const cerebrasModels: Record<string, ModelInfo> = {
    "zai-glm-4.7": {
        id: "zai-glm-4.7",
        name: "zai-glm-4.7",
        description:
            "Highly capable general-purpose model on Cerebras (up to 1,000 tokens/s), competitive with leading proprietary models on coding tasks.",
        capabilities: {
            maxTokens: 40000,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "gpt-oss-120b": {
        id: "gpt-oss-120b",
        name: "gpt-oss-120b",
        description: "Intelligent general purpose model with 3,000 tokens/s",
        capabilities: {
            maxTokens: 65536,
            contextWindow: 128000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "qwen-3-235b-a22b-instruct-2507": {
        id: "qwen-3-235b-a22b-instruct-2507",
        name: "qwen-3-235b-a22b-instruct-2507",
        description: "Intelligent model with ~1400 tokens/s",
        capabilities: {
            maxTokens: 64000,
            contextWindow: 64000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
}

/** Default model ID for Cerebras provider */
export const cerebrasDefaultModelId = "zai-glm-4.7"
