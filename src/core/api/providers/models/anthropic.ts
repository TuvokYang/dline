/**
 * Anthropic provider model definitions.
 * Claude 5.5 metadata verified against official Anthropic model documentation (2026-09-30 UTC).
 */
import type { ModelInfo } from "@shared/api"
import { type ContextWindowBand, ServerTool, type ThinkingConfig } from "@shared/proto/dline/models/metadata"
import { band, flatPricing } from "./pricing"

export const ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS = ["none", "low", "medium", "high", "xhigh", "max"] as const
export const ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH = ["none", "low", "medium", "high", "max"] as const
export const ANTHROPIC_REQUIRED_ADAPTIVE_REASONING_EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const

// Bands used for building 1M variant model pricing (also used by refresh scripts)
export const CLAUDE_SONNET_1M_TIERS: readonly ContextWindowBand[] = [
    band(200_000, 3.0, 15, 3.75, 0.3),
    band(undefined, 6, 22.5, 7.5, 0.6),
]

// Used by refresh scripts to build 1M variant pricing
export const CLAUDE_OPUS_1M_TIERS: readonly ContextWindowBand[] = [
    band(200_000, 5.0, 25, 6.25, 0.5),
    band(undefined, 10, 37.5, 12.5, 1.0),
]

/** Build a known Messages API model declaration without any model-identity inference. */
export function adaptiveThinkingCapabilities(
    effortLevels: readonly string[],
    defaultEnabled = false,
): {
    thinking: ThinkingConfig
    supportsForcedToolUse: boolean
} {
    return {
        thinking: {
            supported: true,
            mode: "effort",
            effortLevels: [...effortLevels],
            defaultEnabled,
            canDisable: effortLevels.includes("none"),
        },
        supportsForcedToolUse: false,
    }
}

export const anthropicModels: Record<string, ModelInfo> = {
    "claude-opus-5-5": {
        id: "claude-opus-5-5",
        name: "claude-opus-5-5",
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            ...adaptiveThinkingCapabilities(ANTHROPIC_REQUIRED_ADAPTIVE_REASONING_EFFORT_OPTIONS, true),
        },
        pricing: flatPricing(4.0, 20.0, 5.0, 0.2),
    },
    "claude-sonnet-5-5": {
        id: "claude-sonnet-5-5",
        name: "claude-sonnet-5-5",
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            ...adaptiveThinkingCapabilities(ANTHROPIC_REQUIRED_ADAPTIVE_REASONING_EFFORT_OPTIONS, true),
        },
        pricing: flatPricing(2.0, 10.0, 2.5, 0.2),
    },
    "claude-fable-5-5": {
        id: "claude-fable-5-5",
        name: "Claude Fable 5.5 (future placeholder)",
        description:
            "Future model placeholder. Official availability, capabilities and pricing are not verified; configure model overrides before use.",
    },
    "claude-opus-5": {
        id: "claude-opus-5",
        name: "claude-opus-5",
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            ...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS, true),
        },
        pricing: flatPricing(5.0, 25.0, 6.25, 0.5),
    },
    "claude-fable-5-1": {
        id: "claude-fable-5-1",
        name: "claude-fable-5-1",
        description:
            "Current Claude Fable model. Adaptive thinking is always on, forced tool use is rejected, and thinking blocks are invalidated when earlier turns are edited.",
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            ...adaptiveThinkingCapabilities(ANTHROPIC_REQUIRED_ADAPTIVE_REASONING_EFFORT_OPTIONS, true),
        },
        // Fable 5.1 keeps Fable 5 pricing except for a cheaper cache read.
        pricing: flatPricing(10.0, 50.0, 12.5, 0.25),
    },
    "claude-fable-5": {
        id: "claude-fable-5",
        name: "claude-fable-5",
        description: "Legacy Claude Fable model. Use claude-fable-5-1 for current Fable capabilities.",
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            ...adaptiveThinkingCapabilities(ANTHROPIC_REQUIRED_ADAPTIVE_REASONING_EFFORT_OPTIONS, true),
        },
        pricing: flatPricing(10.0, 50.0, 12.5, 1.0),
    },
    "claude-opus-4-8": {
        id: "claude-opus-4-8",
        name: "claude-opus-4-8",
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            ...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
        },
        pricing: flatPricing(5.0, 25.0, 6.25, 0.5),
    },
    "claude-sonnet-5": {
        id: "claude-sonnet-5",
        name: "claude-sonnet-5",
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            ...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS, true),
        },
        pricing: flatPricing(2.0, 10.0, 2.5, 0.2),
    },
    "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        name: "claude-sonnet-4-6",
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            ...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH),
        },
        pricing: flatPricing(3.0, 15.0, 3.75, 0.3),
    },
    "claude-opus-4-6": {
        id: "claude-opus-4-6",
        name: "claude-opus-4-6",
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            ...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH),
        },
        pricing: flatPricing(5.0, 25.0, 6.25, 0.5),
    },
    "claude-opus-5:fast": {
        id: "claude-opus-5:fast",
        name: "claude-opus-5:fast",
        description:
            "Anthropic fast mode for Claude Opus 5. Same model and capabilities with higher output token speed at premium pricing. Requires fast mode access on your Anthropic account.",
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            ...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS, true),
        },
        pricing: flatPricing(10.0, 50.0, 12.5, 1.0),
    },
    "claude-opus-4-8:fast": {
        id: "claude-opus-4-8:fast",
        name: "claude-opus-4-8:fast",
        description:
            "Anthropic fast mode for Claude Opus 4.8. Same model and capabilities with higher output token speed at premium pricing. Requires fast mode access on your Anthropic account.",
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            ...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
        },
        pricing: flatPricing(10.0, 50.0, 12.5, 1.0),
    },
    "claude-opus-4-7": {
        id: "claude-opus-4-7",
        name: "claude-opus-4-7",
        capabilities: {
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            maxTokens: 128_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            ...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
        },
        pricing: flatPricing(5.0, 25.0, 6.25, 0.5),
    },
}

// Anthropic model suffix and capability constants
export const CLAUDE_SONNET_1M_SUFFIX = ":1m"
export const ANTHROPIC_FAST_MODE_SUFFIX = ":fast"
export const anthropicDefaultModelId = "claude-opus-5-5"
export const ANTHROPIC_MIN_THINKING_BUDGET = 1_024
export const ANTHROPIC_MAX_THINKING_BUDGET = 6_000

/** Default ModelInfo for Anthropic custom model configuration */
export const anthropicModelInfoSaneDefaults: ModelInfo = {
    id: "",
    capabilities: {
        supportsImages: false,
        supportsPromptCache: true,
        supportsTools: false,
        maxTokens: 384000,
        contextWindow: 1_000_000,
    },
    pricing: flatPricing(1, 2, 0.2, 0.2),
}
