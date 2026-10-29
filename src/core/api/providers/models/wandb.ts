/**
 * W&B Inference by CoreWeave provider model definitions.
 * Extracted from api.ts wandbModels (lines 3532-3689).
 */
import type { ModelInfo } from "@shared/api"

export const wandbModels: Record<string, ModelInfo> = {
    "deepseek-ai/DeepSeek-V3.1": {
        id: "deepseek-ai/DeepSeek-V3.1",
        name: "deepseek-ai/DeepSeek-V3.1",
        description: "A large hybrid model that supports both thinking and non-thinking modes via prompt templates",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 161_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.55,
            outputPrice: 1.65,
        },
    },
    "meta-llama/Llama-4-Scout-17B-16E-Instruct": {
        id: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
        name: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
        description: "Multimodal model integrating text and image understanding, ideal for visual tasks and combined analysis",
        capabilities: {
            maxTokens: 16_384,
            contextWindow: 64_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.17,
            outputPrice: 0.66,
        },
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
        id: "meta-llama/Llama-3.3-70B-Instruct",
        name: "meta-llama/Llama-3.3-70B-Instruct",
        description: "Multilingual model excelling in conversational tasks, detailed instruction-following, and coding",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.71,
            outputPrice: 0.71,
        },
    },
    "meta-llama/Llama-3.1-70B-Instruct": {
        id: "meta-llama/Llama-3.1-70B-Instruct",
        name: "meta-llama/Llama-3.1-70B-Instruct",
        description: "Efficient conversational model optimized for responsive multilingual chatbot interactions",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.8,
            outputPrice: 0.8,
        },
    },
    "meta-llama/Llama-3.1-8B-Instruct": {
        id: "meta-llama/Llama-3.1-8B-Instruct",
        name: "meta-llama/Llama-3.1-8B-Instruct",
        description: "Efficient conversational model optimized for responsive multilingual chatbot interactions",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.22,
            outputPrice: 0.22,
        },
    },
    "microsoft/Phi-4-mini-instruct": {
        id: "microsoft/Phi-4-mini-instruct",
        name: "microsoft/Phi-4-mini-instruct",
        description: "Compact, efficient model ideal for fast responses in resource-constrained environments",
        capabilities: {
            maxTokens: 4_096,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.08,
            outputPrice: 0.35,
        },
    },
    "MiniMaxAI/MiniMax-M2.5": {
        id: "MiniMaxAI/MiniMax-M2.5",
        name: "MiniMaxAI/MiniMax-M2.5",
        description:
            "MoE model with a highly sparse architecture designed for high-throughput and low latency with strong coding capabilities",
        capabilities: {
            maxTokens: 40_960,
            contextWindow: 197_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.3,
            outputPrice: 1.2,
        },
    },
    "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8": {
        id: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8",
        name: "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8",
        description: "A LatentMoE model designed to deliver strong agentic, reasoning, and conversational capabilities",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 262_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.2,
            outputPrice: 0.8,
        },
    },
    "openai/gpt-oss-120b": {
        id: "openai/gpt-oss-120b",
        name: "openai/gpt-oss-120b",
        description: "Efficient Mixture-of-Experts model designed for high-reasoning, agentic and general-purpose use cases",
        capabilities: {
            maxTokens: 32_768,
            contextWindow: 131_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.15,
            outputPrice: 0.6,
        },
    },
    "openai/gpt-oss-20b": {
        id: "openai/gpt-oss-20b",
        name: "openai/gpt-oss-20b",
        description:
            "Lower latency Mixture-of-Experts model trained on OpenAI's Harmony response format with reasoning capabilities",
        capabilities: {
            maxTokens: 32_768,
            contextWindow: 131_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.05,
            outputPrice: 0.2,
        },
    },
    "OpenPipe/Qwen3-14B-Instruct": {
        id: "OpenPipe/Qwen3-14B-Instruct",
        name: "OpenPipe/Qwen3-14B-Instruct",
        description:
            "An efficient multilingual, dense, instruction-tuned model, optimized by OpenPipe for building agents with finetuning",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 32_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.05,
            outputPrice: 0.22,
        },
    },
    "Qwen/Qwen3-235B-A22B-Thinking-2507": {
        id: "Qwen/Qwen3-235B-A22B-Thinking-2507",
        name: "Qwen/Qwen3-235B-A22B-Thinking-2507",
        description:
            "High-performance Mixture-of-Experts model optimized for structured reasoning, math, and long-form generation",
        capabilities: {
            maxTokens: 32_768,
            contextWindow: 262_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.1,
            outputPrice: 0.1,
        },
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
        id: "Qwen/Qwen3-235B-A22B-Instruct-2507",
        name: "Qwen/Qwen3-235B-A22B-Instruct-2507",
        description: "Efficient multilingual, Mixture-of-Experts, instruction-tuned model, optimized for logical reasoning",
        capabilities: {
            maxTokens: 32_768,
            contextWindow: 262_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.1,
            outputPrice: 0.1,
        },
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
        id: "Qwen/Qwen3-30B-A3B-Instruct-2507",
        name: "Qwen/Qwen3-30B-A3B-Instruct-2507",
        description: "MoE instruction-tuned model with enhanced reasoning, coding, and long-context understanding",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 262_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.1,
            outputPrice: 0.3,
        },
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
        id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        name: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        description:
            "Mixture-of-Experts model optimized for agentic coding tasks such as function calling, tool use, and long-context reasoning",
        capabilities: {
            maxTokens: 32_768,
            contextWindow: 262_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 1.0,
            outputPrice: 1.5,
        },
    },
    "zai-org/GLM-5-FP8": {
        id: "zai-org/GLM-5-FP8",
        name: "zai-org/GLM-5-FP8",
        description: "Mixture-of-Experts model for long-horizon agentic tasks with strong performance on reasoning and coding",
        capabilities: {
            maxTokens: 8_192,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 1.0,
            outputPrice: 3.2,
        },
    },
}

/** Default model ID for Weights & Biases (WandB) provider */
export const wandbDefaultModelId = "meta-llama/Llama-3.3-70B-Instruct"
