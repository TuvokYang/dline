/**
 * SambaNova provider model definitions.
 * Extracted from api.ts sambanovaModels (lines 3887-3992).
 */
import type { ModelInfo } from "@shared/api"

export const sambanovaModels: Record<string, ModelInfo> = {
    "DeepSeek-R1-0528": {
        id: "DeepSeek-R1-0528",
        name: "DeepSeek-R1-0528",
        // temperature: 0.6,
        capabilities: {
            maxTokens: 7168,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 5.0,
            outputPrice: 7.0,
        },
    },
    "DeepSeek-R1-Distill-Llama-70B": {
        id: "DeepSeek-R1-Distill-Llama-70B",
        name: "DeepSeek-R1-Distill-Llama-70B",
        // temperature: 0.6,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.7,
            outputPrice: 1.4,
        },
    },
    "DeepSeek-V3-0324": {
        id: "DeepSeek-V3-0324",
        name: "DeepSeek-V3-0324",
        // temperature: 0.3,
        capabilities: {
            maxTokens: 7168,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 3.0,
            outputPrice: 4.5,
        },
    },
    "DeepSeek-V3.1": {
        id: "DeepSeek-V3.1",
        name: "DeepSeek-V3.1",
        // temperature: 0.6,
        capabilities: {
            maxTokens: 7168,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 3.0,
            outputPrice: 4.5,
        },
    },
    "DeepSeek-V3.1-Terminus": {
        id: "DeepSeek-V3.1-Terminus",
        name: "DeepSeek-V3.1-Terminus",
        // temperature: 0.6,
        capabilities: {
            maxTokens: 7168,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 3.0,
            outputPrice: 4.5,
        },
    },
    "Llama-4-Maverick-17B-128E-Instruct": {
        id: "Llama-4-Maverick-17B-128E-Instruct",
        name: "Llama-4-Maverick-17B-128E-Instruct",
        // temperature: 0.6,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 131072,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.63,
            outputPrice: 1.8,
        },
    },
    "Meta-Llama-3.1-8B-Instruct": {
        id: "Meta-Llama-3.1-8B-Instruct",
        name: "Meta-Llama-3.1-8B-Instruct",
        // temperature: 0.6,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 16384,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.1,
            outputPrice: 0.2,
        },
    },
    "Meta-Llama-3.3-70B-Instruct": {
        id: "Meta-Llama-3.3-70B-Instruct",
        name: "Meta-Llama-3.3-70B-Instruct",
        // temperature: 0.6,
        capabilities: {
            maxTokens: 3072,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 1.2,
        },
    },
    "MiniMax-M2.5": {
        id: "MiniMax-M2.5",
        name: "MiniMax-M2.5",

        capabilities: {
            maxTokens: 16384,
            contextWindow: 163840,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.3,
            outputPrice: 1.2,
        },
    },
    "Qwen3-235B": {
        id: "Qwen3-235B",
        name: "Qwen3-235B",
        // temperature: 0.7,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 65536,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.4,
            outputPrice: 0.8,
        },
    },
    "Qwen3-32B": {
        id: "Qwen3-32B",
        name: "Qwen3-32B",
        // temperature: 0.6,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 32768,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.4,
            outputPrice: 0.8,
        },
    },
}

/** Default model ID for SambaNova provider */
export const sambanovaDefaultModelId = "Meta-Llama-3.3-70B-Instruct"
