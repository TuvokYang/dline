/**
 * Baseten provider model definitions.
 * Extracted from api.ts basetenModels (lines 4529-4671).
 */
import type { ModelInfo } from "@shared/api"
import { flatPricing } from "./pricing"

export const basetenModels: Record<string, ModelInfo> = {
    "moonshotai/Kimi-K2-Thinking": {
        id: "moonshotai/Kimi-K2-Thinking",
        name: "moonshotai/Kimi-K2-Thinking",
        description: "Kimi K2 Thinking - A model with enhanced reasoning capabilities from Kimi K2",
        capabilities: {
            supportsTools: true,
            maxTokens: 163_800,
            contextWindow: 262_000,
            supportsImages: false,
            supportsPromptCache: false,
            supportsReasoning: true,
        },
        pricing: flatPricing(0.6, 2.5, 0, 0),
    },
    "zai-org/GLM-4.6": {
        id: "zai-org/GLM-4.6",
        name: "zai-org/GLM-4.6",
        description: "Frontier open model with advanced agentic, reasoning and coding capabilities",
        capabilities: {
            maxTokens: 200_000,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: false,
            supportsReasoning: true,
        },
        pricing: flatPricing(0.6, 2.2, 0, 0),
    },
    "deepseek-ai/DeepSeek-R1": {
        id: "deepseek-ai/DeepSeek-R1",
        name: "deepseek-ai/DeepSeek-R1",
        description: "DeepSeek's first-generation reasoning model",
        capabilities: {
            maxTokens: 131_072,
            contextWindow: 163_840,
            supportsImages: false,
            supportsPromptCache: false,
            supportsReasoning: true,
        },
        pricing: flatPricing(2.55, 5.95, 0, 0),
    },
    "deepseek-ai/DeepSeek-R1-0528": {
        id: "deepseek-ai/DeepSeek-R1-0528",
        name: "deepseek-ai/DeepSeek-R1-0528",
        description: "The latest revision of DeepSeek's first-generation reasoning model",
        capabilities: {
            maxTokens: 131_072,
            contextWindow: 163_840,
            supportsImages: false,
            supportsPromptCache: false,
            supportsReasoning: true,
        },
        pricing: flatPricing(2.55, 5.95, 0, 0),
    },
    "deepseek-ai/DeepSeek-V3-0324": {
        id: "deepseek-ai/DeepSeek-V3-0324",
        name: "deepseek-ai/DeepSeek-V3-0324",
        description: "Fast general-purpose LLM with enhanced reasoning capabilities",
        capabilities: {
            maxTokens: 131_072,
            contextWindow: 163_840,
            supportsImages: false,
            supportsPromptCache: false,
            supportsReasoning: true,
        },
        pricing: flatPricing(0.77, 0.77, 0, 0),
    },
    "deepseek-ai/DeepSeek-V3.1": {
        id: "deepseek-ai/DeepSeek-V3.1",
        name: "deepseek-ai/DeepSeek-V3.1",
        description: "Extremely capable general-purpose LLM with hybrid reasoning capabilities and advanced tool calling",
        capabilities: {
            maxTokens: 131_072,
            contextWindow: 163_840,
            supportsImages: false,
            supportsPromptCache: false,
            supportsReasoning: true,
        },
        pricing: flatPricing(0.5, 1.5, 0, 0),
    },
    "deepseek-ai/DeepSeek-V3.2": {
        id: "deepseek-ai/DeepSeek-V3.2",
        name: "deepseek-ai/DeepSeek-V3.2",
        description: "DeepSeek's hybrid reasoning model with efficient long context scaling with GPT-5 level performance",
        capabilities: {
            supportsTools: true,
            maxTokens: 131_072,
            contextWindow: 163_840,
            supportsImages: false,
            supportsPromptCache: false,
            supportsReasoning: true,
        },
        pricing: flatPricing(0.3, 0.45, 0, 0),
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
        id: "Qwen/Qwen3-235B-A22B-Instruct-2507",
        name: "Qwen/Qwen3-235B-A22B-Instruct-2507",
        description: "Mixture-of-experts LLM with math and reasoning capabilities",
        capabilities: {
            maxTokens: 262_144,
            contextWindow: 262_144,
            supportsImages: false,
            supportsPromptCache: false,
            supportsReasoning: false,
        },
        pricing: flatPricing(0.22, 0.8, 0, 0),
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
        id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        name: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        description: "Mixture-of-experts LLM with advanced coding and reasoning capabilities",
        capabilities: {
            maxTokens: 262_144,
            contextWindow: 262_144,
            supportsImages: false,
            supportsPromptCache: false,
            supportsReasoning: false,
        },
        pricing: flatPricing(0.38, 1.53, 0, 0),
    },
    "openai/gpt-oss-120b": {
        id: "openai/gpt-oss-120b",
        name: "openai/gpt-oss-120b",
        description: "Extremely capable general-purpose LLM with strong, controllable reasoning capabilities",
        capabilities: {
            supportsTools: true,
            maxTokens: 128_072,
            contextWindow: 128_072,
            supportsImages: false,
            supportsPromptCache: false,
            supportsReasoning: true,
        },
        pricing: flatPricing(0.1, 0.5, 0, 0),
    },
    "moonshotai/Kimi-K2-Instruct-0905": {
        id: "moonshotai/Kimi-K2-Instruct-0905",
        name: "moonshotai/Kimi-K2-Instruct-0905",
        description: "State of the art language model for agentic and coding tasks. September Update.",
        capabilities: {
            supportsTools: true,
            maxTokens: 168_000,
            contextWindow: 262_000,
            supportsImages: false,
            supportsPromptCache: false,
            supportsReasoning: false,
        },
        pricing: flatPricing(0.6, 2.5, 0, 0),
    },
}

/** Default model ID for Baseten provider */
export const basetenDefaultModelId = "zai-org/GLM-4.6"
