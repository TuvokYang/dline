/**
 * Qwen (Mainland China) provider model definitions.
 *
 * The mainland endpoint serves its own model set. Only the model IDs Alibaba
 * Cloud Model Studio currently publishes are listed here: the `qwen3-*` open
 * weights IDs, the `qwen2.5-coder-*` family, `qwen-coder-plus`, `qwq-plus` and
 * the original `qwen-vl-*` vision IDs have all left the catalogue, so offering
 * them here would let a Profile be created for a model the gateway rejects.
 *
 * Sources: https://help.aliyun.com/zh/model-studio/text-generation-model and
 * https://help.aliyun.com/zh/model-studio/model-depreciation
 */
import { type ModelInfo } from "@shared/api"
import { ThinkingConfig } from "@shared/proto/dline/models/metadata"
import { flatPricing } from "./pricing"

export const mainlandQwenModels: Record<string, ModelInfo> = {
    "qwen3.8-max": {
        id: "qwen3.8-max",
        name: "qwen3.8-max",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 131_072, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(2.4, 9.6, 2.4, 9.6),
    },
    "qwen3.7-plus": {
        id: "qwen3.7-plus",
        name: "qwen3.7-plus",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 131_072, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.8, 2, 0.8, 2),
    },
    "qwen3.8-flash": {
        id: "qwen3.8-flash",
        name: "qwen3.8-flash",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 131_072, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.3, 0.6, 0.3, 0.6),
    },
    "qwen3.7-max": {
        id: "qwen3.7-max",
        name: "qwen3.7-max",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 131_072, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(2.4, 9.6, 2.4, 9.6),
    },
    "qwen3.7-flash": {
        id: "qwen3.7-flash",
        name: "qwen3.7-flash",
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 65_536, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.3, 0.6, 0.3, 0.6),
    },
    "qwen3.6-plus": {
        id: "qwen3.6-plus",
        name: "qwen3.6-plus",
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 65_536, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.8, 2, 0.8, 2),
    },
    "qwen3.6-flash": {
        id: "qwen3.6-flash",
        name: "qwen3.6-flash",
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 65_536, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.3, 0.6, 0.3, 0.6),
    },
    "qwen3.6-35b-a3b": {
        id: "qwen3.6-35b-a3b",
        name: "qwen3.6-35b-a3b",
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 256_000,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 65_536, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.75, 3, 0.75, 3),
    },
    "qwen3.5-plus": {
        id: "qwen3.5-plus",
        name: "qwen3.5-plus",
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 65_536, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.8, 2, 0.8, 2),
    },
    "qwen3.5-flash": {
        id: "qwen3.5-flash",
        name: "qwen3.5-flash",
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 65_536, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.3, 0.6, 0.3, 0.6),
    },
    "qwen3-coder-flash": {
        id: "qwen3-coder-flash",
        name: "qwen3-coder-flash",
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 65_536, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.3, 1.2, 0.3, 1.2),
    },
    "qwen-plus": {
        id: "qwen-plus",
        name: "qwen-plus",
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 65_536, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.8, 2, 0.8, 2),
    },
    "qwen-flash": {
        id: "qwen-flash",
        name: "qwen-flash",
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 65_536, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.3, 0.6, 0.3, 0.6),
    },
    "qwen-max": {
        id: "qwen-max",
        name: "qwen-max",
        capabilities: {
            maxTokens: 32_768,
            contextWindow: 32_768,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: flatPricing(2.4, 9.6, 2.4, 9.6),
    },
    "qwen3-vl-plus": {
        id: "qwen3-vl-plus",
        name: "qwen3-vl-plus",
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 65_536, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(1.5, 4.5, 1.5, 4.5),
    },
    "deepseek-v4.1-flash": {
        id: "deepseek-v4.1-flash",
        name: "deepseek-v4.1-flash",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ maxBudget: 131_072, supported: true, mode: "budget" }),
        },
        pricing: flatPricing(0.28, 1.1, 0.28, 1.1),
    },
}

/** Default model ID for Qwen mainland China provider */
export const mainlandQwenDefaultModelId = "qwen3.7-plus"
