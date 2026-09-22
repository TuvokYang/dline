/**
 * Anthropic provider model definitions.
 * Extracted from api.ts anthropicModels (lines 184-423).
 */
import type { ModelInfo } from "@shared/api"
import { ServerTool, type ThinkingConfig } from "@shared/proto/dline/models/metadata"
import {
	ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS,
	ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH,
	ANTHROPIC_REQUIRED_ADAPTIVE_REASONING_EFFORT_OPTIONS,
} from "@shared/utils/reasoning-support"

// Tiers used for building 1M variant model pricing (also used by refresh scripts)
export const CLAUDE_SONNET_1M_TIERS = [
	{
		contextWindow: 200000,
		inputPrice: 3.0,
		outputPrice: 15,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	},
	{
		contextWindow: 1_000_000,
		inputPrice: 6,
		outputPrice: 22.5,
		cacheWritesPrice: 7.5,
		cacheReadsPrice: 0.6,
	},
]

// Used by refresh scripts to build 1M variant pricing
export const CLAUDE_OPUS_1M_TIERS = [
	{
		contextWindow: 200000,
		inputPrice: 5.0,
		outputPrice: 25,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
	},
	{
		contextWindow: 1_000_000,
		inputPrice: 10,
		outputPrice: 37.5,
		cacheWritesPrice: 12.5,
		cacheReadsPrice: 1.0,
	},
]

function adaptiveThinking(effortLevels: readonly string[]): ThinkingConfig {
	return { supported: true, mode: "effort", effortLevels: [...effortLevels] }
}

export const anthropicModels: Record<string, ModelInfo> = {
	"claude-opus-5-5": {
		id: "claude-opus-5-5",
		name: "claude-opus-5-5",
		capabilities: {
			supportsTools: true,
			tools: [ServerTool.WEB_SEARCH],
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: adaptiveThinking(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 4.0,
			outputPrice: 20.0,
			cacheWritesPrice: 5.0,
			cacheReadsPrice: 0.2,
		},
	},
	"claude-opus-5": {
		id: "claude-opus-5",
		name: "claude-opus-5",
		capabilities: {
			supportsTools: true,
			tools: [ServerTool.WEB_SEARCH],
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: adaptiveThinking(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
	},
	"claude-fable-5-1": {
		id: "claude-fable-5-1",
		name: "claude-fable-5-1",
		description:
			"Current Claude Fable model. Adaptive thinking is always on, forced tool use is rejected, and thinking blocks are invalidated when earlier turns are edited.",
		capabilities: {
			supportsTools: true,
			tools: [ServerTool.WEB_SEARCH],
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: adaptiveThinking(ANTHROPIC_REQUIRED_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 10.0,
			outputPrice: 50.0,
			cacheWritesPrice: 12.5,
			// Fable 5.1 keeps Fable 5 pricing except for a cheaper cache read.
			cacheReadsPrice: 0.25,
		},
	},
	"claude-fable-5": {
		id: "claude-fable-5",
		name: "claude-fable-5",
		description: "Legacy Claude Fable model. Use claude-fable-5-1 for current Fable capabilities.",
		capabilities: {
			supportsTools: true,
			tools: [ServerTool.WEB_SEARCH],
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: adaptiveThinking(ANTHROPIC_REQUIRED_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 10.0,
			outputPrice: 50.0,
			cacheWritesPrice: 12.5,
			cacheReadsPrice: 1.0,
		},
	},
	"claude-opus-4-8": {
		id: "claude-opus-4-8",
		name: "claude-opus-4-8",
		capabilities: {
			supportsTools: true,
			tools: [ServerTool.WEB_SEARCH],
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: adaptiveThinking(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
	},
	"claude-sonnet-5": {
		id: "claude-sonnet-5",
		name: "claude-sonnet-5",
		capabilities: {
			supportsTools: true,
			tools: [ServerTool.WEB_SEARCH],
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: adaptiveThinking(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 2.0,
			outputPrice: 10.0,
			cacheWritesPrice: 2.5,
			cacheReadsPrice: 0.2,
		},
	},
	"claude-sonnet-4-6": {
		id: "claude-sonnet-4-6",
		name: "claude-sonnet-4-6",
		capabilities: {
			supportsTools: true,
			tools: [ServerTool.WEB_SEARCH],
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: adaptiveThinking(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH),
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
		},
	},
	"claude-opus-4-6": {
		id: "claude-opus-4-6",
		name: "claude-opus-4-6",
		capabilities: {
			supportsTools: true,
			tools: [ServerTool.WEB_SEARCH],
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: adaptiveThinking(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH),
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
	},
	"claude-opus-5:fast": {
		id: "claude-opus-5:fast",
		name: "claude-opus-5:fast",
		description:
			"Anthropic fast mode for Claude Opus 5. Same model and capabilities with higher output token speed at premium pricing. Requires fast mode access on your Anthropic account.",
		capabilities: {
			supportsTools: true,
			tools: [ServerTool.WEB_SEARCH],
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: adaptiveThinking(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 10.0,
			outputPrice: 50.0,
			cacheWritesPrice: 12.5,
			cacheReadsPrice: 1.0,
		},
	},
	"claude-opus-4-8:fast": {
		id: "claude-opus-4-8:fast",
		name: "claude-opus-4-8:fast",
		description:
			"Anthropic fast mode for Claude Opus 4.8. Same model and capabilities with higher output token speed at premium pricing. Requires fast mode access on your Anthropic account.",
		capabilities: {
			supportsTools: true,
			tools: [ServerTool.WEB_SEARCH],
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: adaptiveThinking(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 10.0,
			outputPrice: 50.0,
			cacheWritesPrice: 12.5,
			cacheReadsPrice: 1.0,
		},
	},
	"claude-opus-4-7": {
		id: "claude-opus-4-7",
		name: "claude-opus-4-7",
		capabilities: {
			supportsTools: true,
			tools: [ServerTool.WEB_SEARCH],
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: adaptiveThinking(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
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
		supportsReasoning: true,
		supportsTools: false,
		maxTokens: 384000,
		contextWindow: 1_000_000,
		thinking: {
			supported: true,
			mode: "budget",
			maxBudget: 64000,
			effortLevels: [],
		},
	},
	pricing: {
		inputPrice: 1,
		outputPrice: 2,
		cacheWritesPrice: 0.2,
		cacheReadsPrice: 0.2,
	},
}
