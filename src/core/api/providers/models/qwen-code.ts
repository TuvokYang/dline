/**
 * Qwen Code provider model definitions.
 * Extracted from api.ts qwenCodeModels (lines 4948-4979).
 */
import type { ModelInfo } from "@shared/api"

export const qwenCodeModels: Record<string, ModelInfo> = {
    "qwen3-coder-plus": {
        id: "qwen3-coder-plus",
        name: "qwen3-coder-plus",
        description: "Qwen3 Coder Plus - High-performance coding model with 1M context window for large codebases",
        capabilities: {
            maxTokens: 65_536,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0,
        },
    },
    "qwen3-coder-flash": {
        id: "qwen3-coder-flash",
        name: "qwen3-coder-flash",
        description: "Qwen3 Coder Flash - Fast coding model with 1M context window optimized for speed",
        capabilities: {
            maxTokens: 65_536,
            contextWindow: 1_000_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
            cacheWritesPrice: 0,
            cacheReadsPrice: 0,
        },
    },
}

/** Default model ID for Qwen Code provider */
export const qwenCodeDefaultModelId = "qwen3-coder-plus"
