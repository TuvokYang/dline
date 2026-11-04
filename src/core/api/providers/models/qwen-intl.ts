/**
 * Qwen (International) provider model definitions.
 *
 * The international endpoint serves the same catalogue family as the mainland
 * one; this file mirrors `qwen-cn.ts` so a Profile keeps the same choices when
 * it switches region. Model IDs that left the Alibaba Cloud catalogue (the
 * `qwen3-*` open weights IDs, `qwen2.5-coder-*`, `qwen-coder-plus`, `qwq-plus`
 * and the original `qwen-vl-*` IDs) are not declared here.
 */
import { type ModelInfo } from "@shared/api"
import { ThinkingConfig } from "@shared/proto/dline/models/metadata"
import { flatPricing } from "./pricing"

export const internationalQwenModels: Record<string, ModelInfo> = {
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

/** Default model ID for Qwen international provider */
export const internationalQwenDefaultModelId = "qwen3.7-plus"

/** Qwen API region selector */
export enum QwenApiRegions {
    CHINA = "china",
    INTERNATIONAL = "international",
}
