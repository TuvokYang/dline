/**
 * Moonshot AI Studio provider model definitions.
 * Extracted from api.ts moonshotModels (lines 4388-4452).
 */
import type { ModelInfo } from "@shared/api"

export const moonshotModels: Record<string, ModelInfo> = {
    "kimi-k2.5": {
        id: "kimi-k2.5",
        name: "kimi-k2.5",

        capabilities: {
            maxTokens: 32_000,
            contextWindow: 262_144,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 3.0,
            cacheReadsPrice: 0.1,
        },
    },
    "kimi-k2-0905-preview": {
        id: "kimi-k2-0905-preview",
        name: "kimi-k2-0905-preview",
        // temperature: 0.6,
        capabilities: {
            maxTokens: 16384,
            contextWindow: 262144,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 2.5,
        },
    },
    "kimi-k2-0711-preview": {
        id: "kimi-k2-0711-preview",
        name: "kimi-k2-0711-preview",
        // temperature: 0.6,
        capabilities: {
            maxTokens: 32_000,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 2.5,
        },
    },
    "kimi-k2-turbo-preview": {
        id: "kimi-k2-turbo-preview",
        name: "kimi-k2-turbo-preview",
        // temperature: 0.6,
        capabilities: {
            maxTokens: 32_000,
            contextWindow: 262_144,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2.4,
            outputPrice: 10,
        },
    },
    "kimi-k2-thinking": {
        id: "kimi-k2-thinking",
        name: "kimi-k2-thinking",

        capabilities: {
            maxTokens: 32_000,
            contextWindow: 262_144,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 2.5,
        },
    },
    "kimi-k2-thinking-turbo": {
        id: "kimi-k2-thinking-turbo",
        name: "kimi-k2-thinking-turbo",

        capabilities: {
            maxTokens: 32_000,
            contextWindow: 262_144,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2.4,
            outputPrice: 10,
        },
    },
}

/** Default model ID for Moonshot provider */
export const moonshotDefaultModelId = "kimi-k2-0905-preview"
