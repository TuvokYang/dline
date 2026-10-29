/**
 * OpenRouter provider constants.
 * Model list is fetched dynamically at runtime; only default model and pricing
 * constants live here.
 */

import type { ModelInfo } from "@shared/api"

// Local suffix constant for constructing 1M variant model IDs
const CLAUDE_SONNET_1M_SUFFIX = ":1m"

/** Default model ID for OpenRouter provider */
export const openRouterDefaultModelId = "anthropic/claude-sonnet-4.5"

/** Default ModelInfo for OpenRouter provider */
export const openRouterDefaultModelInfo: ModelInfo = {
    id: "",
    description: "Claude Sonnet 4.5 delivers superior intelligence across coding, agentic search, and AI agent capabilities.",
    capabilities: {
        supportsImages: true,
        supportsPromptCache: true,
        supportsReasoning: true,
        supportsTools: true,
        maxTokens: 64_000,
        contextWindow: 200_000,
    },
    pricing: {
        inputPrice: 3.0,
        outputPrice: 15.0,
        cacheWritesPrice: 3.75,
        cacheReadsPrice: 0.3,
    },
}

/** OpenRouter Claude Sonnet 1M variant model IDs */
export const openRouterClaudeSonnet41mModelId = `anthropic/claude-sonnet-4${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeSonnet451mModelId = `anthropic/claude-sonnet-4.5${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeSonnet461mModelId = `anthropic/claude-sonnet-4.6${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeOpus461mModelId = `anthropic/claude-opus-4.6${CLAUDE_SONNET_1M_SUFFIX}`
export const openRouterClaudeOpus471mModelId = `anthropic/claude-opus-4.7${CLAUDE_SONNET_1M_SUFFIX}`

/** OpenRouter provider preferences */
export const OPENROUTER_PROVIDER_PREFERENCES: Record<string, { order: string[]; allow_fallbacks: boolean }> = {}
