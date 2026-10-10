/**
 * Doubao provider model definitions.
 * Extracted from api.ts doubaoModels (lines 3013-3059).
 */
import type { ModelInfo } from "@shared/api"

export const doubaoModels: Record<string, ModelInfo> = {
    "doubao-1-5-pro-256k-250115": {
        id: "doubao-1-5-pro-256k-250115",
        name: "doubao-1-5-pro-256k-250115",
        capabilities: {
            maxTokens: 12_288,
            contextWindow: 256_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.7,
            outputPrice: 1.3,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0,
        },
    },
    "doubao-1-5-pro-32k-250115": {
        id: "doubao-1-5-pro-32k-250115",
        name: "doubao-1-5-pro-32k-250115",
        capabilities: {
            maxTokens: 12_288,
            contextWindow: 32_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.11,
            outputPrice: 0.3,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0,
        },
    },
    "deepseek-v3-250324": {
        id: "deepseek-v3-250324",
        name: "deepseek-v3-250324",
        capabilities: {
            maxTokens: 12_288,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.55,
            outputPrice: 2.19,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0,
        },
    },
    "deepseek-r1-250120": {
        id: "deepseek-r1-250120",
        name: "deepseek-r1-250120",
        capabilities: {
            maxTokens: 32_768,
            contextWindow: 64_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.27,
            outputPrice: 1.09,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0,
        },
    },
}

/** Default model ID for Doubao provider */
export const doubaoDefaultModelId = "doubao-1-5-pro-256k-250115"
