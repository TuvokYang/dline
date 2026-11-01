/**
 * Z.AI (Mainland China) provider model definitions.
 * Extracted from api.ts mainlandZAiModels (lines 4737-4842).
 */
import type { ModelInfo } from "@shared/api"
import { band, bandedPricing, flatPricing } from "./pricing"

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
        pricing: flatPricing(1.4, 4.4, undefined, 0.26),
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
        pricing: flatPricing(1.0, 3.2, undefined, 0.2),
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
        pricing: flatPricing(0.6, 2.2, undefined, 0.11),
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
        pricing: flatPricing(0.6, 2.2, undefined, 0.11),
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
        pricing: bandedPricing([
            band(32_000, 0.21, 1.0, 0, 0.043),
            band(128_000, 0.29, 1.14, 0, 0.057),
            band(undefined, 0.29, 1.14, 0, 0.057),
        ]),
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
        pricing: bandedPricing([
            band(32_000, 0.057, 0.43, 0, 0.011),
            band(128_000, 0.086, 0.57, 0, 0.017),
            band(undefined, 0.086, 0.57, 0, 0.017),
        ]),
    },
}

/** Default model ID for ZAi mainland China provider */
export const mainlandZAiDefaultModelId = "glm-5.1"
