/**
 * xAI provider model definitions.
 * Extracted from api.ts xaiModels (lines 3690-3886).
 */
import type { ModelInfo } from "@shared/api"

export const xaiModels: Record<string, ModelInfo> = {
    "grok-4-1-fast-reasoning": {
        id: "grok-4-1-fast-reasoning",
        name: "grok-4-1-fast-reasoning",
        description: "xAI's Grok 4.1 Reasoning Fast - multimodal model with 2M context.",
        capabilities: {
            maxTokens: 0,
            contextWindow: 2_000_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.2,
            cacheReadsPrice: 0.05,
            outputPrice: 0.5,
        },
    },
    "grok-4-1-fast-non-reasoning": {
        id: "grok-4-1-fast-non-reasoning",
        name: "grok-4-1-fast-non-reasoning",
        description: "xAI's Grok 4.1 Non-Reasoning Fast - multimodal model with 2M context.",
        capabilities: {
            maxTokens: 0,
            contextWindow: 2_000_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.2,
            cacheReadsPrice: 0.05,
            outputPrice: 0.5,
        },
    },
    "grok-code-fast-1": {
        id: "grok-code-fast-1",
        name: "grok-code-fast-1",
        description: "xAI's Grok Coding model.",
        capabilities: {
            maxTokens: 0,
            contextWindow: 256_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.2,
            cacheReadsPrice: 0.02,
            outputPrice: 1.5,
        },
    },
    "grok-4-fast-reasoning": {
        id: "grok-4-fast-reasoning",
        name: "grok-4-fast-reasoning",
        description: "xAI's Grok 4 Fast (free) multimodal model with 2M context.",
        capabilities: {
            maxTokens: 30000,
            contextWindow: 2000000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.2,
            cacheReadsPrice: 0.05,
            outputPrice: 0.5,
        },
    },
    "grok-4": {
        id: "grok-4",
        name: "grok-4",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 262144,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 3.0,
            cacheReadsPrice: 0.75,
            outputPrice: 15.0,
        },
    },
    "grok-3-beta": {
        id: "grok-3-beta",
        name: "grok-3-beta",
        description: "X AI's Grok-3 beta model with 131K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 3.0,
            outputPrice: 15.0,
        },
    },
    "grok-3-fast-beta": {
        id: "grok-3-fast-beta",
        name: "grok-3-fast-beta",
        description: "X AI's Grok-3 fast beta model with 131K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 5.0,
            outputPrice: 25.0,
        },
    },
    "grok-3-mini-beta": {
        id: "grok-3-mini-beta",
        name: "grok-3-mini-beta",
        description: "X AI's Grok-3 mini beta model with 131K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.3,
            outputPrice: 0.5,
        },
    },
    "grok-3-mini-fast-beta": {
        id: "grok-3-mini-fast-beta",
        name: "grok-3-mini-fast-beta",
        description: "X AI's Grok-3 mini fast beta model with 131K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 4.0,
        },
    },
    "grok-3": {
        id: "grok-3",
        name: "grok-3",
        description: "X AI's Grok-3 model with 131K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 3.0,
            outputPrice: 15.0,
        },
    },
    "grok-3-fast": {
        id: "grok-3-fast",
        name: "grok-3-fast",
        description: "X AI's Grok-3 fast model with 131K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 5.0,
            outputPrice: 25.0,
        },
    },
    "grok-3-mini": {
        id: "grok-3-mini",
        name: "grok-3-mini",
        description: "X AI's Grok-3 mini model with 131K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.3,
            outputPrice: 0.5,
        },
    },
    "grok-3-mini-fast": {
        id: "grok-3-mini-fast",
        name: "grok-3-mini-fast",
        description: "X AI's Grok-3 mini fast model with 131K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 4.0,
        },
    },
    "grok-2-latest": {
        id: "grok-2-latest",
        name: "grok-2-latest",
        description: "X AI's Grok-2 model - latest version with 131K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2.0,
            outputPrice: 10.0,
        },
    },
    "grok-2": {
        id: "grok-2",
        name: "grok-2",
        description: "X AI's Grok-2 model with 131K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2.0,
            outputPrice: 10.0,
        },
    },
    "grok-2-1212": {
        id: "grok-2-1212",
        name: "grok-2-1212",
        description: "X AI's Grok-2 model (version 1212) with 131K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2.0,
            outputPrice: 10.0,
        },
    },
    "grok-2-vision-latest": {
        id: "grok-2-vision-latest",
        name: "grok-2-vision-latest",
        description: "X AI's Grok-2 Vision model - latest version with image support and 32K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 32768,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2.0,
            outputPrice: 10.0,
        },
    },
    "grok-2-vision": {
        id: "grok-2-vision",
        name: "grok-2-vision",
        description: "X AI's Grok-2 Vision model with image support and 32K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 32768,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2.0,
            outputPrice: 10.0,
        },
    },
    "grok-2-vision-1212": {
        id: "grok-2-vision-1212",
        name: "grok-2-vision-1212",
        description: "X AI's Grok-2 Vision model (version 1212) with image support and 32K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 32768,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2.0,
            outputPrice: 10.0,
        },
    },
    "grok-vision-beta": {
        id: "grok-vision-beta",
        name: "grok-vision-beta",
        description: "X AI's Grok Vision Beta model with image support and 8K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 8192,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 5.0,
            outputPrice: 15.0,
        },
    },
    "grok-beta": {
        id: "grok-beta",
        name: "grok-beta",
        description: "X AI's Grok Beta model (legacy) with 131K context window",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 5.0,
            outputPrice: 15.0,
        },
    },
}

/** Default model ID for xAI provider */
export const xaiDefaultModelId = "grok-4"
