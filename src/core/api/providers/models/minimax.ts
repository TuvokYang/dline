/**
 * Minimax provider model definitions.
 * Extracted from api.ts minimaxModels (lines 4980-5062).
 */
import type { ModelInfo } from "@shared/api"
import type { ThinkingConfig } from "@shared/proto/dline/models/metadata"

// M2.x thinking is always active; the Anthropic-compatible API has no budget control.
const M2_THINKING: ThinkingConfig = { supported: true, mode: "effort", effortLevels: [], defaultEnabled: true, canDisable: false }

export const minimaxModels: Record<string, ModelInfo> = {
	"MiniMax-M2.7": {
		id: "MiniMax-M2.7",
		name: "MiniMax-M2.7",
		description: "Latest flagship model with enhanced reasoning and coding",
		capabilities: {
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 192_000,
			supportsImages: false,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: { ...M2_THINKING },
		},
		pricing: {
			inputPrice: 0.3,
			outputPrice: 1.2,
			cacheWritesPrice: 0.375,
			cacheReadsPrice: 0.06,
		},
	},
	"MiniMax-M2.7-highspeed": {
		id: "MiniMax-M2.7-highspeed",
		name: "MiniMax-M2.7-highspeed",
		description: "High-speed version of M2.7 for low-latency scenarios",
		capabilities: {
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 192_000,
			supportsImages: false,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: { ...M2_THINKING },
		},
		pricing: {
			inputPrice: 0.6,
			outputPrice: 2.4,
			cacheWritesPrice: 0.375,
			cacheReadsPrice: 0.06,
		},
	},
	"MiniMax-M2.5": {
		id: "MiniMax-M2.5",
		name: "MiniMax-M2.5",
		capabilities: {
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 192_000,
			supportsImages: false,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: { ...M2_THINKING },
		},
		pricing: {
			inputPrice: 0.3,
			outputPrice: 1.2,
			cacheWritesPrice: 0.375,
			cacheReadsPrice: 0.03,
		},
	},
	"MiniMax-M2.5-highspeed": {
		id: "MiniMax-M2.5-highspeed",
		name: "MiniMax-M2.5-highspeed",
		capabilities: {
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 192_000,
			supportsImages: false,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: { ...M2_THINKING },
		},
		pricing: {
			inputPrice: 0.6,
			outputPrice: 2.4,
			cacheWritesPrice: 0.375,
			cacheReadsPrice: 0.03,
		},
	},
	"MiniMax-M2.1": {
		id: "MiniMax-M2.1",
		name: "MiniMax-M2.1",
		capabilities: {
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 192_000,
			supportsImages: false,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: { ...M2_THINKING },
		},
		pricing: {
			inputPrice: 0.3,
			outputPrice: 1.2,
			cacheWritesPrice: 0.375,
			cacheReadsPrice: 0.03,
		},
	},
	"MiniMax-M2.1-lightning": {
		id: "MiniMax-M2.1-lightning",
		name: "MiniMax-M2.1-lightning",
		capabilities: {
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 192_000,
			supportsImages: false,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 0.6,
			outputPrice: 2.4,
			cacheWritesPrice: 0.375,
			cacheReadsPrice: 0.03,
		},
	},
	"MiniMax-M2": {
		id: "MiniMax-M2",
		name: "MiniMax-M2",
		capabilities: {
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 192_000,
			supportsImages: false,
			supportsPromptCache: false,
			supportsReasoning: true,
			thinking: { ...M2_THINKING },
		},
		pricing: {
			inputPrice: 0.3,
			outputPrice: 1.2,
			cacheWritesPrice: 0,
			cacheReadsPrice: 0,
		},
	},
}

/** Default model ID for MiniMax provider */
export const minimaxDefaultModelId = "MiniMax-M2.7"
