/**
 * Nebius AI Studio provider model definitions.
 * Extracted from api.ts nebiusModels (lines 3349-3531).
 */
import type { ModelInfo } from "@shared/api"

export const nebiusModels: Record<string, ModelInfo> = {
    "deepseek-ai/DeepSeek-V3": {
        id: "deepseek-ai/DeepSeek-V3",
        name: "deepseek-ai/DeepSeek-V3",
        capabilities: {
            maxTokens: 32_000,
            contextWindow: 96_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.5,
            outputPrice: 1.5,
        },
    },
    "deepseek-ai/DeepSeek-V3-0324-fast": {
        id: "deepseek-ai/DeepSeek-V3-0324-fast",
        name: "deepseek-ai/DeepSeek-V3-0324-fast",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2,
            outputPrice: 6,
        },
    },
    "deepseek-ai/DeepSeek-R1": {
        id: "deepseek-ai/DeepSeek-R1",
        name: "deepseek-ai/DeepSeek-R1",
        capabilities: {
            maxTokens: 32_000,
            contextWindow: 96_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.8,
            outputPrice: 2.4,
        },
    },
    "deepseek-ai/DeepSeek-R1-fast": {
        id: "deepseek-ai/DeepSeek-R1-fast",
        name: "deepseek-ai/DeepSeek-R1-fast",
        capabilities: {
            maxTokens: 32_000,
            contextWindow: 96_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2,
            outputPrice: 6,
        },
    },
    "deepseek-ai/DeepSeek-R1-0528": {
        id: "deepseek-ai/DeepSeek-R1-0528",
        name: "deepseek-ai/DeepSeek-R1-0528",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 163_840,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.8,
            outputPrice: 2.4,
        },
    },
    "meta-llama/Llama-3.3-70B-Instruct-fast": {
        id: "meta-llama/Llama-3.3-70B-Instruct-fast",
        name: "meta-llama/Llama-3.3-70B-Instruct-fast",
        capabilities: {
            maxTokens: 32_000,
            contextWindow: 96_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.25,
            outputPrice: 0.75,
        },
    },
    "Qwen/Qwen2.5-32B-Instruct-fast": {
        id: "Qwen/Qwen2.5-32B-Instruct-fast",
        name: "Qwen/Qwen2.5-32B-Instruct-fast",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 32_768,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.13,
            outputPrice: 0.4,
        },
    },
    "Qwen/Qwen2.5-Coder-32B-Instruct-fast": {
        id: "Qwen/Qwen2.5-Coder-32B-Instruct-fast",
        name: "Qwen/Qwen2.5-Coder-32B-Instruct-fast",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.1,
            outputPrice: 0.3,
        },
    },
    "Qwen/Qwen3-4B-fast": {
        id: "Qwen/Qwen3-4B-fast",
        name: "Qwen/Qwen3-4B-fast",
        capabilities: {
            maxTokens: 32_000,
            contextWindow: 41_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.08,
            outputPrice: 0.24,
        },
    },
    "Qwen/Qwen3-30B-A3B-fast": {
        id: "Qwen/Qwen3-30B-A3B-fast",
        name: "Qwen/Qwen3-30B-A3B-fast",
        capabilities: {
            maxTokens: 32_000,
            contextWindow: 41_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.3,
            outputPrice: 0.9,
        },
    },
    "Qwen/Qwen3-235B-A22B": {
        id: "Qwen/Qwen3-235B-A22B",
        name: "Qwen/Qwen3-235B-A22B",
        capabilities: {
            maxTokens: 32_000,
            contextWindow: 41_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.2,
            outputPrice: 0.6,
        },
    },
    "openai/gpt-oss-120b": {
        id: "openai/gpt-oss-120b",
        name: "openai/gpt-oss-120b",
        capabilities: {
            maxTokens: 32766,
            contextWindow: 131_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.15,
            outputPrice: 0.6,
        },
    },
    "moonshotai/Kimi-K2-Instruct": {
        id: "moonshotai/Kimi-K2-Instruct",
        name: "moonshotai/Kimi-K2-Instruct",
        capabilities: {
            maxTokens: 16384,
            contextWindow: 131_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.5,
            outputPrice: 2.4,
        },
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
        id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        name: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        capabilities: {
            maxTokens: 163800,
            contextWindow: 262_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.4,
            outputPrice: 1.8,
        },
    },
    "openai/gpt-oss-20b": {
        id: "openai/gpt-oss-20b",
        name: "openai/gpt-oss-20b",
        capabilities: {
            maxTokens: 32766,
            contextWindow: 131_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.05,
            outputPrice: 0.2,
        },
    },
    "zai-org/GLM-4.5": {
        id: "zai-org/GLM-4.5",
        name: "zai-org/GLM-4.5",
        capabilities: {
            maxTokens: 98304,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 2.2,
        },
    },
    "zai-org/GLM-4.5-Air": {
        id: "zai-org/GLM-4.5-Air",
        name: "zai-org/GLM-4.5-Air",
        capabilities: {
            maxTokens: 98304,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.2,
            outputPrice: 1.2,
        },
    },
    "deepseek-ai/DeepSeek-R1-0528-fast": {
        id: "deepseek-ai/DeepSeek-R1-0528-fast",
        name: "deepseek-ai/DeepSeek-R1-0528-fast",
        capabilities: {
            maxTokens: 128000,
            contextWindow: 164_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2.0,
            outputPrice: 6.0,
        },
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
        id: "Qwen/Qwen3-235B-A22B-Instruct-2507",
        name: "Qwen/Qwen3-235B-A22B-Instruct-2507",
        capabilities: {
            maxTokens: 64000,
            contextWindow: 262_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.2,
            outputPrice: 0.6,
        },
    },
    "Qwen/Qwen3-30B-A3B": {
        id: "Qwen/Qwen3-30B-A3B",
        name: "Qwen/Qwen3-30B-A3B",
        capabilities: {
            maxTokens: 32000,
            contextWindow: 41_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.1,
            outputPrice: 0.3,
        },
    },
    "Qwen/Qwen3-32B": {
        id: "Qwen/Qwen3-32B",
        name: "Qwen/Qwen3-32B",
        capabilities: {
            maxTokens: 16384,
            contextWindow: 41_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.1,
            outputPrice: 0.3,
        },
    },
    "Qwen/Qwen3-32B-fast": {
        id: "Qwen/Qwen3-32B-fast",
        name: "Qwen/Qwen3-32B-fast",
        capabilities: {
            maxTokens: 16384,
            contextWindow: 41_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.2,
            outputPrice: 0.6,
        },
    },
}

/** Default model ID for Nebius provider */
export const nebiusDefaultModelId = "Qwen/Qwen2.5-32B-Instruct-fast"
