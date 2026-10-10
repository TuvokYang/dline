/**
 * Fireworks AI provider model definitions.
 * Extracted from api.ts fireworksModels (lines 4843-4947).
 */
import type { ModelInfo } from "@shared/api"

export const fireworksModels: Record<string, ModelInfo> = {
    "accounts/fireworks/models/kimi-k2p5": {
        id: "accounts/fireworks/models/kimi-k2p5",
        name: "accounts/fireworks/models/kimi-k2p5",
        description:
            "Moonshot's flagship open agentic model. Kimi K2.5 unifies vision and text, thinking and non-thinking modes, and single-agent and multi-agent execution.",
        capabilities: {
            maxTokens: 16384,
            contextWindow: 262144,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 3,
            cacheWritesPrice: 0.6,
            cacheReadsPrice: 0.1,
        },
    },
    "accounts/fireworks/models/qwen3-vl-30b-a3b-thinking": {
        id: "accounts/fireworks/models/qwen3-vl-30b-a3b-thinking",
        name: "accounts/fireworks/models/qwen3-vl-30b-a3b-thinking",
        description:
            "Reasoning-enabled Qwen3-VL model with strong multimodal understanding, long context support, and function calling.",
        capabilities: {
            maxTokens: 32768,
            contextWindow: 262144,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.15,
            outputPrice: 0.6,
            cacheWritesPrice: 0.15,
            cacheReadsPrice: 0.07,
        },
    },
    "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct": {
        id: "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct",
        name: "accounts/fireworks/models/qwen3-vl-30b-a3b-instruct",
        description: "Qwen3-VL instruct model with strong multimodal reasoning, long context support, and function calling.",
        capabilities: {
            maxTokens: 32768,
            contextWindow: 262144,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.15,
            outputPrice: 0.6,
        },
    },
    "accounts/fireworks/models/deepseek-v3p2": {
        id: "accounts/fireworks/models/deepseek-v3p2",
        name: "accounts/fireworks/models/deepseek-v3p2",
        description: "DeepSeek V3.2 model tuned for high computational efficiency and strong reasoning and agent performance.",
        capabilities: {
            maxTokens: 16384,
            contextWindow: 163840,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.56,
            outputPrice: 1.68,
            cacheWritesPrice: 0.56,
            cacheReadsPrice: 0.28,
        },
    },
    "accounts/fireworks/models/glm-4p7": {
        id: "accounts/fireworks/models/glm-4p7",
        name: "accounts/fireworks/models/glm-4p7",
        description: "GLM-4.7 is a next-generation general-purpose model optimized for coding, reasoning, and agentic workflows.",
        capabilities: {
            maxTokens: 16384,
            contextWindow: 202752,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.6,
            outputPrice: 2.2,
            cacheWritesPrice: 0.6,
            cacheReadsPrice: 0.3,
        },
    },
    "accounts/fireworks/models/glm-5": {
        id: "accounts/fireworks/models/glm-5",
        name: "accounts/fireworks/models/glm-5",
        description: "GLM-5 is Z.ai's flagship reasoning model for complex systems engineering and long-horizon agentic tasks.",
        capabilities: {
            maxTokens: 16384,
            contextWindow: 202752,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 1.0,
            outputPrice: 3.2,
            cacheWritesPrice: 1.0,
            cacheReadsPrice: 0.2,
        },
    },
    "accounts/fireworks/models/minimax-m2p5": {
        id: "accounts/fireworks/models/minimax-m2p5",
        name: "accounts/fireworks/models/minimax-m2p5",
        description: "MiniMax M2.5 is built for state-of-the-art coding, agentic tool use.",
        capabilities: {
            maxTokens: 16384,
            contextWindow: 196608,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.3,
            outputPrice: 1.2,
            cacheWritesPrice: 0.3,
            cacheReadsPrice: 0.03,
        },
    },
    "accounts/fireworks/models/minimax-m2p1": {
        id: "accounts/fireworks/models/minimax-m2p1",
        name: "accounts/fireworks/models/minimax-m2p1",
        description:
            "MiniMax M2.1 is tuned for strong real-world performance across coding, agent-driven, and workflow-heavy tasks.",
        capabilities: {
            maxTokens: 16384,
            contextWindow: 196608,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.3,
            outputPrice: 1.2,
            cacheWritesPrice: 0.3,
            cacheReadsPrice: 0.03,
        },
    },
    "accounts/fireworks/models/gpt-oss-120b": {
        id: "accounts/fireworks/models/gpt-oss-120b",
        name: "accounts/fireworks/models/gpt-oss-120b",
        description: "OpenAI gpt-oss-120b open-weight model for production and high-reasoning use cases.",
        capabilities: {
            maxTokens: 16384,
            contextWindow: 131072,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: {
            inputPrice: 0.15,
            outputPrice: 0.6,
            cacheWritesPrice: 0.15,
            cacheReadsPrice: 0.01,
        },
    },
}

/** Default model ID for Fireworks provider */
export const fireworksDefaultModelId = "accounts/fireworks/models/kimi-k2p5"
