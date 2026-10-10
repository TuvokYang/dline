/**
 * Huawei Cloud MaaS provider model definitions.
 * Extracted from api.ts huaweiCloudMaasModels (lines 4453-4528).
 */
import { type ModelInfo } from "@shared/api"
import { ThinkingConfig } from "@shared/proto/dline/models/metadata"

export const huaweiCloudMaasModels: Record<string, ModelInfo> = {
    "DeepSeek-V3": {
        id: "DeepSeek-V3",
        name: "DeepSeek-V3",
        capabilities: {
            maxTokens: 16_384,
            contextWindow: 64_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.27,
            outputPrice: 1.1,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0,
        },
    },
    "DeepSeek-R1": {
        id: "DeepSeek-R1",
        name: "DeepSeek-R1",
        capabilities: {
            maxTokens: 16_384,
            contextWindow: 64_000,
            supportsImages: false,
            supportsPromptCache: false,
            thinking: ThinkingConfig.create({ supported: true, mode: "budget", maxBudget: 8192 }),
        },
        pricing: {
            inputPrice: 0.55,
            outputPrice: 2.2,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0,
            thinkingOutputPrice: 2.2,
        },
    },
    "deepseek-r1-250528": {
        id: "deepseek-r1-250528",
        name: "deepseek-r1-250528",
        capabilities: {
            maxTokens: 16_384,
            contextWindow: 64_000,
            supportsImages: false,
            supportsPromptCache: false,
            thinking: ThinkingConfig.create({ supported: true, mode: "budget", maxBudget: 8192 }),
        },
        pricing: {
            inputPrice: 0.55,
            outputPrice: 2.2,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0,
            thinkingOutputPrice: 2.2,
        },
    },
    "qwen3-235b-a22b": {
        id: "qwen3-235b-a22b",
        name: "qwen3-235b-a22b",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 32_000,
            supportsImages: false,
            supportsPromptCache: false,
            thinking: ThinkingConfig.create({ supported: true, mode: "budget", maxBudget: 4096 }),
        },
        pricing: {
            inputPrice: 0.27,
            outputPrice: 1.1,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0,
            thinkingOutputPrice: 1.1,
        },
    },
    "qwen3-32b": {
        id: "qwen3-32b",
        name: "qwen3-32b",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 32_000,
            supportsImages: false,
            supportsPromptCache: false,
            thinking: ThinkingConfig.create({ supported: true, mode: "budget", maxBudget: 4096 }),
        },
        pricing: {
            inputPrice: 0.27,
            outputPrice: 1.1,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0,
            thinkingOutputPrice: 1.1,
        },
    },
}

/** Default model ID for Huawei Cloud MaaS provider */
export const huaweiCloudMaasDefaultModelId = "DeepSeek-V3"
