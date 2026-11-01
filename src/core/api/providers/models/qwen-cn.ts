/**
 * Qwen (Mainland China) provider model definitions.
 * Extracted from api.ts mainlandQwenModels (lines 2654-3012).
 */
import { type ModelInfo } from "@shared/api"
import { ThinkingConfig } from "@shared/proto/dline/models/metadata"
import { flatPricing } from "./pricing"

export const mainlandQwenModels: Record<string, ModelInfo> = {
    "qwen3-235b-a22b": {
        id: "qwen3-235b-a22b",
        name: "qwen3-235b-a22b",
        capabilities: {
            maxTokens: 16_384,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
            thinking: ThinkingConfig.create({ maxBudget: 38_912, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(2, 8, 2, 8, "USD", 20),
    },
    "qwen3-32b": {
        id: "qwen3-32b",
        name: "qwen3-32b",
        capabilities: {
            maxTokens: 16_384,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
            thinking: ThinkingConfig.create({ maxBudget: 38_912, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(2, 8, 2, 8, "USD", 20),
    },
    "qwen3-30b-a3b": {
        id: "qwen3-30b-a3b",
        name: "qwen3-30b-a3b",
        capabilities: {
            maxTokens: 16_384,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
            thinking: ThinkingConfig.create({ maxBudget: 38_912, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.75, 3, 0.75, 3, "USD", 7.5),
    },
    "qwen3-14b": {
        id: "qwen3-14b",
        name: "qwen3-14b",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
            thinking: ThinkingConfig.create({ maxBudget: 38_912, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(1, 4, 1, 4, "USD", 10),
    },
    "qwen3-8b": {
        id: "qwen3-8b",
        name: "qwen3-8b",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
            thinking: ThinkingConfig.create({ maxBudget: 38_912, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.5, 2, 0.5, 2, "USD", 5),
    },
    "qwen3-4b": {
        id: "qwen3-4b",
        name: "qwen3-4b",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
            thinking: ThinkingConfig.create({ maxBudget: 38_912, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.3, 1.2, 0.3, 1.2, "USD", 3),
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
        pricing: flatPricing(0.3, 1.2, 0.3, 1.2, "USD", 3),
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
        pricing: flatPricing(0.3, 1.2, 0.3, 1.2, "USD", 3),
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
        pricing: flatPricing(0.002, 0.006, 0.002, 0.006),
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
        pricing: flatPricing(0.002, 0.006, 0.002, 0.006),
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
        pricing: flatPricing(0.001, 0.002, 0.001, 0.002),
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
        pricing: flatPricing(0.0, 0.0, 0.0, 0.0),
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
        pricing: flatPricing(0.0, 0.0, 0.0, 0.0),
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
        pricing: flatPricing(0.0, 0.0, 0.0, 0.0),
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
        pricing: flatPricing(3.5, 7, 3.5, 7),
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
        pricing: flatPricing(0.8, 2, 0.8, 2),
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
        pricing: flatPricing(0.3, 0.6, 0.3, 0.6),
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
        pricing: flatPricing(2.4, 9.6, 2.4, 9.6),
    },
    "qwq-plus-latest": {
        id: "qwq-plus-latest",
        name: "qwq-plus-latest",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 131_071,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0.0, 0.0, 0.0, 0.0),
    },
    "qwq-plus": {
        id: "qwq-plus",
        name: "qwq-plus",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 131_071,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0.0, 0.0, 0.0, 0.0),
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
        pricing: flatPricing(3.5, 7, 3.5, 7),
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
        pricing: flatPricing(0.8, 2, 0.8, 0.2),
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
        pricing: flatPricing(0.3, 0.6, 0.3, 0.6),
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
        pricing: flatPricing(2.4, 9.6, 2.4, 9.6),
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
        pricing: flatPricing(0, 0.28, 0.14, 0.014),
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
        pricing: flatPricing(0, 2.19, 0.55, 0.14),
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
        pricing: flatPricing(3, 9, 3, 9),
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
        pricing: flatPricing(3, 9, 3, 9),
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
        pricing: flatPricing(1.5, 4.5, 1.5, 4.5),
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
        pricing: flatPricing(1.5, 4.5, 1.5, 4.5),
    },
}

/** Default model ID for Qwen mainland China provider */
export const mainlandQwenDefaultModelId = "qwen3-coder-plus"
