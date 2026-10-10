/**
 * Z.AI (Mainland China) provider model definitions.
 * Extracted from api.ts mainlandZAiModels (lines 4737-4842).
 */
import type { ModelInfo } from "@shared/api"

export const mainlandZAiModels: Record<string, ModelInfo> = {
    "glm-5.1": {
        id: "glm-5.1",
        name: "glm-5.1",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 1.4,
            outputPrice: 4.4,
            cacheReadsPrice: 0.26,
        },
    },
    "glm-5": {
        id: "glm-5",
        name: "glm-5",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            cacheReadsPrice: 0.2,
            inputPrice: 1.0,
            outputPrice: 3.2,
        },
    },
    "glm-4.7": {
        id: "glm-4.7",
        name: "glm-4.7",
        capabilities: {
            maxTokens: 131_000,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 2.2,
            cacheReadsPrice: 0.11,
        },
    },
    "glm-4.6": {
        id: "glm-4.6",
        name: "glm-4.6",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 2.2,
            cacheReadsPrice: 0.11,
        },
    },
    "glm-4.5": {
        id: "glm-4.5",
        name: "glm-4.5",
        description:
            "GLM-4.5 is Zhipu's latest featured model. Its comprehensive capabilities in reasoning, coding, and agent reach the state-of-the-art (SOTA) level among open-source models, with a context length of up to 128k.",
        capabilities: {
            maxTokens: 98_304,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.29,
            outputPrice: 1.14,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0.057,
            tiers: [
                {
                    contextWindow: 32_000,
                    inputPrice: 0.21,
                    outputPrice: 1.0,
                    cacheReadsPrice: 0.043,
                },
                {
                    contextWindow: 128_000,
                    inputPrice: 0.29,
                    outputPrice: 1.14,
                    cacheReadsPrice: 0.057,
                },
                {
                    contextWindow: Number.POSITIVE_INFINITY,
                    inputPrice: 0.29,
                    outputPrice: 1.14,
                    cacheReadsPrice: 0.057,
                },
            ],
        },
    },
    "glm-4.5-air": {
        id: "glm-4.5-air",
        name: "glm-4.5-air",
        description:
            "GLM-4.5-Air is the lightweight version of GLM-4.5. It balances performance and cost-effectiveness, and can flexibly switch to hybrid thinking models.",
        capabilities: {
            maxTokens: 98304,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.086,
            outputPrice: 0.57,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0.017,
            tiers: [
                {
                    contextWindow: 32_000,
                    inputPrice: 0.057,
                    outputPrice: 0.43,
                    cacheReadsPrice: 0.011,
                },
                {
                    contextWindow: 128_000,
                    inputPrice: 0.086,
                    outputPrice: 0.57,
                    cacheReadsPrice: 0.017,
                },
                {
                    contextWindow: Number.POSITIVE_INFINITY,
                    inputPrice: 0.086,
                    outputPrice: 0.57,
                    cacheReadsPrice: 0.017,
                },
            ],
        },
    },
}

/** Default model ID for ZAi mainland China provider */
export const mainlandZAiDefaultModelId = "glm-5.1"
