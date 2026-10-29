/**
 * Qwen (International) provider model definitions.
 * Extracted from api.ts internationalQwenModels (lines 2315-2653).
 */
import { type ModelInfo } from "@shared/api"

export const internationalQwenModels: Record<string, ModelInfo> = {
    "qwen3-coder-plus": {
        id: "qwen3-coder-plus",
        name: "qwen3-coder-plus",
        capabilities: {
            maxTokens: 65_536,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 1,
            outputPrice: 5,
        },
    },
    "qwen3-coder-480b-a35b-instruct": {
        id: "qwen3-coder-480b-a35b-instruct",
        name: "qwen3-coder-480b-a35b-instruct",
        capabilities: {
            maxTokens: 65_536,
            contextWindow: 204_800,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 1.5,
            outputPrice: 7.5,
        },
    },
    "qwen3-235b-a22b": {
        id: "qwen3-235b-a22b",
        name: "qwen3-235b-a22b",
        capabilities: {
            maxTokens: 16_384,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2,
            outputPrice: 8,
            cacheWritesPrice: 2,
            cacheReadsPrice: 8,
        },
    },
    "qwen3-32b": {
        id: "qwen3-32b",
        name: "qwen3-32b",
        capabilities: {
            maxTokens: 16_384,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2,
            outputPrice: 8,
            cacheWritesPrice: 2,
            cacheReadsPrice: 8,
        },
    },
    "qwen3-30b-a3b": {
        id: "qwen3-30b-a3b",
        name: "qwen3-30b-a3b",
        capabilities: {
            maxTokens: 16_384,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.75,
            outputPrice: 3,
            cacheWritesPrice: 0.75,
            cacheReadsPrice: 3,
        },
    },
    "qwen3-14b": {
        id: "qwen3-14b",
        name: "qwen3-14b",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 1,
            outputPrice: 4,
            cacheWritesPrice: 1,
            cacheReadsPrice: 4,
        },
    },
    "qwen3-8b": {
        id: "qwen3-8b",
        name: "qwen3-8b",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.5,
            outputPrice: 2,
            cacheWritesPrice: 0.5,
            cacheReadsPrice: 2,
        },
    },
    "qwen3-4b": {
        id: "qwen3-4b",
        name: "qwen3-4b",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.3,
            outputPrice: 1.2,
            cacheWritesPrice: 0.3,
            cacheReadsPrice: 1.2,
        },
    },
    "qwen3-1.7b": {
        id: "qwen3-1.7b",
        name: "qwen3-1.7b",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 32_768,
            supportsImages: false,
            supportsPromptCache: false,
            thinking: { supported: true, mode: "budget", maxBudget: 30_720 },
        },
        pricing: {
            inputPrice: 0.3,
            outputPrice: 1.2,
            cacheWritesPrice: 0.3,
            cacheReadsPrice: 1.2,
            thinkingOutputPrice: 3,
        },
    },
    "qwen3-0.6b": {
        id: "qwen3-0.6b",
        name: "qwen3-0.6b",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 32_768,
            supportsImages: false,
            supportsPromptCache: false,
            thinking: { supported: true, mode: "budget", maxBudget: 30_720 },
        },
        pricing: {
            inputPrice: 0.3,
            outputPrice: 1.2,
            cacheWritesPrice: 0.3,
            cacheReadsPrice: 1.2,
            thinkingOutputPrice: 3,
        },
    },
    "qwen2.5-coder-32b-instruct": {
        id: "qwen2.5-coder-32b-instruct",
        name: "qwen2.5-coder-32b-instruct",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.002,
            outputPrice: 0.006,
            cacheWritesPrice: 0.002,
            cacheReadsPrice: 0.006,
        },
    },
    "qwen2.5-coder-14b-instruct": {
        id: "qwen2.5-coder-14b-instruct",
        name: "qwen2.5-coder-14b-instruct",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.002,
            outputPrice: 0.006,
            cacheWritesPrice: 0.002,
            cacheReadsPrice: 0.006,
        },
    },
    "qwen2.5-coder-7b-instruct": {
        id: "qwen2.5-coder-7b-instruct",
        name: "qwen2.5-coder-7b-instruct",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.001,
            outputPrice: 0.002,
            cacheWritesPrice: 0.001,
            cacheReadsPrice: 0.002,
        },
    },
    "qwen2.5-coder-3b-instruct": {
        id: "qwen2.5-coder-3b-instruct",
        name: "qwen2.5-coder-3b-instruct",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 32_768,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.0,
            outputPrice: 0.0,
            cacheWritesPrice: 0.0,
            cacheReadsPrice: 0.0,
        },
    },
    "qwen2.5-coder-1.5b-instruct": {
        id: "qwen2.5-coder-1.5b-instruct",
        name: "qwen2.5-coder-1.5b-instruct",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 32_768,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.0,
            outputPrice: 0.0,
            cacheWritesPrice: 0.0,
            cacheReadsPrice: 0.0,
        },
    },
    "qwen2.5-coder-0.5b-instruct": {
        id: "qwen2.5-coder-0.5b-instruct",
        name: "qwen2.5-coder-0.5b-instruct",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 32_768,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.0,
            outputPrice: 0.0,
            cacheWritesPrice: 0.0,
            cacheReadsPrice: 0.0,
        },
    },
    "qwen-coder-plus-latest": {
        id: "qwen-coder-plus-latest",
        name: "qwen-coder-plus-latest",
        capabilities: {
            maxTokens: 129_024,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 3.5,
            outputPrice: 7,
            cacheWritesPrice: 3.5,
            cacheReadsPrice: 7,
        },
    },
    "qwen-plus-latest": {
        id: "qwen-plus-latest",
        name: "qwen-plus-latest",
        capabilities: {
            maxTokens: 16_384,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.8,
            outputPrice: 2,
            cacheWritesPrice: 0.8,
            cacheReadsPrice: 2,
        },
    },
    "qwen-turbo-latest": {
        id: "qwen-turbo-latest",
        name: "qwen-turbo-latest",
        capabilities: {
            maxTokens: 16_384,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.3,
            outputPrice: 0.6,
            cacheWritesPrice: 0.3,
            cacheReadsPrice: 0.6,
        },
    },
    "qwen-max-latest": {
        id: "qwen-max-latest",
        name: "qwen-max-latest",
        capabilities: {
            maxTokens: 30_720,
            contextWindow: 32_768,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2.4,
            outputPrice: 9.6,
            cacheWritesPrice: 2.4,
            cacheReadsPrice: 9.6,
        },
    },
    "qwen-coder-plus": {
        id: "qwen-coder-plus",
        name: "qwen-coder-plus",
        capabilities: {
            maxTokens: 129_024,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 3.5,
            outputPrice: 7,
            cacheWritesPrice: 3.5,
            cacheReadsPrice: 7,
        },
    },
    "qwen-plus": {
        id: "qwen-plus",
        name: "qwen-plus",
        capabilities: {
            maxTokens: 129_024,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.8,
            outputPrice: 2,
            cacheWritesPrice: 0.8,
            cacheReadsPrice: 0.2,
        },
    },
    "qwen-turbo": {
        id: "qwen-turbo",
        name: "qwen-turbo",
        capabilities: {
            maxTokens: 1_000_000,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.3,
            outputPrice: 0.6,
            cacheWritesPrice: 0.3,
            cacheReadsPrice: 0.6,
        },
    },
    "qwen-max": {
        id: "qwen-max",
        name: "qwen-max",
        capabilities: {
            maxTokens: 30_720,
            contextWindow: 32_768,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2.4,
            outputPrice: 9.6,
            cacheWritesPrice: 2.4,
            cacheReadsPrice: 9.6,
        },
    },
    "deepseek-v3": {
        id: "deepseek-v3",
        name: "deepseek-v3",
        capabilities: {
            maxTokens: 8_000,
            contextWindow: 64_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0.28,
            cacheWritesPrice: 0.14,
            cacheReadsPrice: 0.014,
        },
    },
    "deepseek-r1": {
        id: "deepseek-r1",
        name: "deepseek-r1",
        capabilities: {
            maxTokens: 8_000,
            contextWindow: 64_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 2.19,
            cacheWritesPrice: 0.55,
            cacheReadsPrice: 0.14,
        },
    },
    "qwen-vl-max": {
        id: "qwen-vl-max",
        name: "qwen-vl-max",
        capabilities: {
            maxTokens: 30_720,
            contextWindow: 32_768,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 3,
            outputPrice: 9,
            cacheWritesPrice: 3,
            cacheReadsPrice: 9,
        },
    },
    "qwen-vl-max-latest": {
        id: "qwen-vl-max-latest",
        name: "qwen-vl-max-latest",
        capabilities: {
            maxTokens: 129_024,
            contextWindow: 131_072,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 3,
            outputPrice: 9,
            cacheWritesPrice: 3,
            cacheReadsPrice: 9,
        },
    },
    "qwen-vl-plus": {
        id: "qwen-vl-plus",
        name: "qwen-vl-plus",
        capabilities: {
            maxTokens: 6_000,
            contextWindow: 8_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 1.5,
            outputPrice: 4.5,
            cacheWritesPrice: 1.5,
            cacheReadsPrice: 4.5,
        },
    },
    "qwen-vl-plus-latest": {
        id: "qwen-vl-plus-latest",
        name: "qwen-vl-plus-latest",
        capabilities: {
            maxTokens: 129_024,
            contextWindow: 131_072,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 1.5,
            outputPrice: 4.5,
            cacheWritesPrice: 1.5,
            cacheReadsPrice: 4.5,
        },
    },
}

/** Default model ID for Qwen international provider */
export const internationalQwenDefaultModelId = "qwen3-coder-plus"

/** Qwen API region selector */
export enum QwenApiRegions {
    CHINA = "china",
    INTERNATIONAL = "international",
}
