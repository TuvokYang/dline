/**
 * Hugging Face Inference Providers model definitions.
 * Extracted from api.ts huggingFaceModels (lines 2244-2314).
 */
import type { ModelInfo } from "@shared/api"

export const huggingFaceModels: Record<string, ModelInfo> = {
    "openai/gpt-oss-120b": {
        id: "openai/gpt-oss-120b",
        name: "openai/gpt-oss-120b",
        description:
            "Large open-weight reasoning model for high-end desktops and data centers, built for complex coding, math, and general AI tasks.",
        capabilities: {
            maxTokens: 32766,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "openai/gpt-oss-20b": {
        id: "openai/gpt-oss-20b",
        name: "openai/gpt-oss-20b",
        description:
            "Medium open-weight reasoning model that runs on most desktops, balancing strong reasoning with broad accessibility.",
        capabilities: {
            maxTokens: 32766,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "moonshotai/Kimi-K2-Instruct": {
        id: "moonshotai/Kimi-K2-Instruct",
        name: "moonshotai/Kimi-K2-Instruct",
        description: "Advanced reasoning model with superior performance across coding, math, and general capabilities.",
        capabilities: {
            maxTokens: 131_072,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "deepseek-ai/DeepSeek-V3-0324": {
        id: "deepseek-ai/DeepSeek-V3-0324",
        name: "deepseek-ai/DeepSeek-V3-0324",
        description: "Advanced reasoning model with superior performance across coding, math, and general capabilities.",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 64_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "deepseek-ai/DeepSeek-R1": {
        id: "deepseek-ai/DeepSeek-R1",
        name: "deepseek-ai/DeepSeek-R1",
        description: "DeepSeek's reasoning model with step-by-step thinking capabilities.",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 64_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "deepseek-ai/DeepSeek-R1-0528": {
        id: "deepseek-ai/DeepSeek-R1-0528",
        name: "deepseek-ai/DeepSeek-R1-0528",
        description: "DeepSeek's reasoning model's latest version with step-by-step thinking capabilities",
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 64_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "meta-llama/Llama-3.1-8B-Instruct": {
        id: "meta-llama/Llama-3.1-8B-Instruct",
        name: "meta-llama/Llama-3.1-8B-Instruct",
        description: "Efficient 8B parameter Llama model for general-purpose tasks.",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
}

/** Default model ID for HuggingFace provider */
export const huggingFaceDefaultModelId = "moonshotai/Kimi-K2-Instruct"
