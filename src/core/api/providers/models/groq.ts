/**
 * Groq provider model definitions.
 * Extracted from api.ts groqModels (lines 4030-4166).
 */
import type { ModelInfo } from "@shared/api"

export const groqModels: Record<string, ModelInfo> = {
    "openai/gpt-oss-120b": {
        id: "openai/gpt-oss-120b",
        name: "openai/gpt-oss-120b",
        description:
            "A state-of-the-art 120B open-weight Mixture-of-Experts language model optimized for strong reasoning, tool use, and efficient deployment on large GPUs",
        capabilities: {
            supportsTools: true,
            maxTokens: 32766,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.15,
            outputPrice: 0.75,
        },
    },
    "openai/gpt-oss-20b": {
        id: "openai/gpt-oss-20b",
        name: "openai/gpt-oss-20b",
        description:
            "A compact 20B open-weight Mixture-of-Experts language model designed for strong reasoning and tool use, ideal for edge devices and local inference.",
        capabilities: {
            supportsTools: true,
            maxTokens: 32766,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.1,
            outputPrice: 0.5,
        },
    },
    "compound-beta": {
        id: "compound-beta",
        name: "compound-beta",
        description:
            "Compound model using Llama 4 Scout for core reasoning with Llama 3.3 70B for routing and tool use. Excellent for plan/act workflows.",
        capabilities: {
            supportsTools: true,
            maxTokens: 8192,
            contextWindow: 128000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.0,
            outputPrice: 0.0,
        },
    },
    "compound-beta-mini": {
        id: "compound-beta-mini",
        name: "compound-beta-mini",
        description: "Lightweight compound model for faster inference while maintaining tool use capabilities.",
        capabilities: {
            supportsTools: true,
            maxTokens: 8192,
            contextWindow: 128000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.0,
            outputPrice: 0.0,
        },
    },
    "deepseek-r1-distill-llama-70b": {
        id: "deepseek-r1-distill-llama-70b",
        name: "deepseek-r1-distill-llama-70b",
        description:
            "DeepSeek R1 reasoning capabilities distilled into Llama 70B architecture. Excellent for complex problem-solving and planning.",
        capabilities: {
            supportsTools: true,
            maxTokens: 131072,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.75,
            outputPrice: 0.99,
        },
    },
    "meta-llama/llama-4-maverick-17b-128e-instruct": {
        id: "meta-llama/llama-4-maverick-17b-128e-instruct",
        name: "meta-llama/llama-4-maverick-17b-128e-instruct",
        description: "Meta's Llama 4 Maverick 17B model with 128 experts, supports vision and multimodal tasks.",
        capabilities: {
            supportsTools: true,
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.2,
            outputPrice: 0.6,
        },
    },
    "meta-llama/llama-4-scout-17b-16e-instruct": {
        id: "meta-llama/llama-4-scout-17b-16e-instruct",
        name: "meta-llama/llama-4-scout-17b-16e-instruct",
        description: "Meta's Llama 4 Scout 17B model with 16 experts, optimized for fast inference and general tasks.",
        capabilities: {
            supportsTools: true,
            maxTokens: 8192,
            contextWindow: 131072,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.11,
            outputPrice: 0.34,
        },
    },
    "llama-3.3-70b-versatile": {
        id: "llama-3.3-70b-versatile",
        name: "llama-3.3-70b-versatile",
        description: "Meta's latest Llama 3.3 70B model optimized for versatile use cases with excellent performance and speed.",
        capabilities: {
            supportsTools: true,
            maxTokens: 32768,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.59,
            outputPrice: 0.79,
        },
    },
    "llama-3.1-8b-instant": {
        id: "llama-3.1-8b-instant",
        name: "llama-3.1-8b-instant",
        description: "Fast and efficient Llama 3.1 8B model optimized for speed, low latency, and reliable tool execution.",
        capabilities: {
            supportsTools: true,
            maxTokens: 131072,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.05,
            outputPrice: 0.08,
        },
    },
    "moonshotai/kimi-k2-instruct": {
        id: "moonshotai/kimi-k2-instruct",
        name: "moonshotai/kimi-k2-instruct",
        description:
            "Kimi K2 is Moonshot AI's state-of-the-art Mixture-of-Experts (MoE) language model with 1 trillion total parameters and 32 billion activated parameters.",
        capabilities: {
            supportsTools: true,
            maxTokens: 16384,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 1.0,
            outputPrice: 3.0,
            cacheReadsPrice: 0.5,
        },
    },
    "moonshotai/kimi-k2-instruct-0905": {
        id: "moonshotai/kimi-k2-instruct-0905",
        name: "moonshotai/kimi-k2-instruct-0905",
        description:
            "Kimi K2 model gets a new version update: Agentic coding: more accurate, better generalization across scaffolds. Frontend coding: improved aesthetics and functionalities on web, 3d, and other tasks. Context length: extended from 128k to 256k, providing better long-horizon support.",
        capabilities: {
            supportsTools: true,
            maxTokens: 16384,
            contextWindow: 262144,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 2.5,
            cacheReadsPrice: 0.15,
        },
    },
}

/** Default model ID for Groq provider */
export const groqDefaultModelId = "moonshotai/kimi-k2-instruct-0905"
