/**
 * Claude Code provider model definitions.
 * Extracted from api.ts claudeCodeModels (lines 428-526).
 * Each entry spreads an anthropicModels value with overrides — all spreads are inlined here.
 */
import type { ModelInfo, ThinkingConfig } from "@shared/api"
import {
	ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS,
	ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH,
} from "@shared/utils/reasoning-support"

/**
 * Adaptive-thinking metadata, mirroring the Anthropic catalog.
 *
 * The handler reads this to decide whether a request carries an effort level or
 * an explicit token budget; a model that declares neither would be sent the
 * wrong shape and rejected.
 */
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
 * Models available to a Claude Code subscription.
 *
 * Entries mirror the Anthropic catalog and are pruned against the published
 * model lifecycle. A retired model is removed rather than left selectable,
 * because the API rejects it outright instead of degrading, so offering it
 * would only turn a stale selection into a failed request.
 *
 * The beta-gated 1M context variants stay absent, since that window was sold
 * as metered extra usage. A model whose native window is already 1M keeps it,
 * which is a different thing from opting into the retired beta.
 *
 * Every model declares `supportsTools`, because the request now reaches the
 * Messages API directly. The server-side `tools` list stays empty for the same
 * reason the metered variants are absent.
 */
export const claudeCodeModels: Record<string, ModelInfo> = {
	// claude-opus-5-5 → ...anthropicModels["claude-opus-5-5"]
	"claude-opus-5-5": {
		id: "claude-opus-5-5",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsTools: true,
		},
		pricing: {
			inputPrice: 4.0,
			outputPrice: 20.0,
			cacheWritesPrice: 5.0,
			cacheReadsPrice: 0.2,
		},
	},
	// claude-opus-5 → ...anthropicModels["claude-opus-5"]
	"claude-opus-5": {
		id: "claude-opus-5",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsTools: true,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
	},
	// claude-opus-4-8 → ...anthropicModels["claude-opus-4-8"]
	"claude-opus-4-8": {
		id: "claude-opus-4-8",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsTools: true,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
	},
	// claude-sonnet-5 → ...anthropicModels["claude-sonnet-5"]
	"claude-sonnet-5": {
		id: "claude-sonnet-5",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsTools: true,
		},
		pricing: {
			inputPrice: 2.0,
			outputPrice: 10.0,
			cacheWritesPrice: 2.5,
			cacheReadsPrice: 0.2,
		},
	},
	// claude-haiku-4-5-20251001 → ...anthropicModels["claude-haiku-4-5-20251001"]
	"claude-haiku-4-5-20251001": {
		id: "claude-haiku-4-5-20251001",
		capabilities: {
			maxTokens: 64_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsTools: true,
		},
		pricing: {
			inputPrice: 1,
			outputPrice: 5.0,
			cacheWritesPrice: 1.25,
			cacheReadsPrice: 0.1,
		},
	},
	// claude-sonnet-4-6 → ...anthropicModels["claude-sonnet-4-6"]
	"claude-sonnet-4-6": {
		id: "claude-sonnet-4-6",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH),
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsTools: true,
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
		},
	},
	// claude-sonnet-4-5-20250929 → ...anthropicModels["claude-sonnet-4-5-20250929"]
	"claude-sonnet-4-5-20250929": {
		id: "claude-sonnet-4-5-20250929",
		capabilities: {
			maxTokens: 64_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsTools: true,
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
		},
	},
	// claude-opus-4-6 → ...anthropicModels["claude-opus-4-6"]
	"claude-opus-4-6": {
		id: "claude-opus-4-6",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH),
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsTools: true,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
	},
	// claude-opus-4-7 → ...anthropicModels["claude-opus-4-7"]
	"claude-opus-4-7": {
		id: "claude-opus-4-7",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsTools: true,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
	},
	// claude-opus-4-5-20251101 → ...anthropicModels["claude-opus-4-5-20251101"]
	"claude-opus-4-5-20251101": {
		id: "claude-opus-4-5-20251101",
		capabilities: {
			maxTokens: 64_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsTools: true,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
	},
}

/** Default model ID for Claude Code provider */
export const claudeCodeDefaultModelId = "claude-opus-5-5"
