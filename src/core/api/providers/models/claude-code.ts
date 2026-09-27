/**
 * Claude Code provider model definitions.
 *
 * A subscription reaches the same Messages API as the anthropic provider, so
 * each model declares the same capabilities, including hosted web search.
 */
import type { ModelInfo } from "@shared/api"
import { ServerTool, type ThinkingConfig } from "@shared/proto/dline/models/metadata"
import {
	ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS,
	ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH,
	ANTHROPIC_REQUIRED_ADAPTIVE_REASONING_EFFORT_OPTIONS,
} from "@shared/utils/reasoning-support"

function adaptiveThinking(effortLevels: readonly string[]): ThinkingConfig {
	return { supported: true, mode: "effort", effortLevels: [...effortLevels] }
}

/**
 * Capabilities shared by every adaptive-thinking model.
 *
 * Adaptive thinking stays on, and thinking cannot be combined with a forced
 * tool choice, so these models reject `tool_choice: any` with an error instead
 * of degrading to an automatic choice. Declaring it here keeps the rule with
 * the thinking mode that causes it, rather than repeating it per model.
 */
function adaptiveThinkingCapabilities(effortLevels: readonly string[]): {
	thinking: ThinkingConfig
	supportsForcedToolUse: boolean
} {
	return { thinking: adaptiveThinking(effortLevels), supportsForcedToolUse: false }
}

/**
 * Models offered to a Claude Code subscription.
 *
 * This set is the whole offer. The remote listing only refreshes metadata for
 * these IDs and never adds others, so a superseded model the account can still
 * call does not reappear in the picker.
 *
 * Pricing is reference information only. A subscription is paid by plan, so
 * the handler reports no per-request cost; the prices stay so models can still
 * be compared by their public list price.
 */
export const claudeCodeModels: Record<string, ModelInfo> = {
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
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 4.0,
			outputPrice: 20.0,
			cacheWritesPrice: 5.0,
			cacheReadsPrice: 0.2,
		},
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
			...adaptiveThinkingCapabilities(ANTHROPIC_REQUIRED_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 10.0,
			outputPrice: 50.0,
			cacheWritesPrice: 12.5,
			// Fable 5.1 keeps Fable 5 pricing except for a cheaper cache read.
			cacheReadsPrice: 0.25,
		},
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
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 2.0,
			outputPrice: 10.0,
			cacheWritesPrice: 2.5,
			cacheReadsPrice: 0.2,
		},
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
			...adaptiveThinkingCapabilities(ANTHROPIC_REQUIRED_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 10.0,
			outputPrice: 50.0,
			cacheWritesPrice: 12.5,
			cacheReadsPrice: 1.0,
		},
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
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
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
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
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
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
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
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
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
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
		},
	},
}

/** Default model ID for Claude Code provider */
export const claudeCodeDefaultModelId = "claude-opus-5-5"
