/**
 * DeepSeek provider model definitions.
 * Extracted from api.ts deepSeekModels (lines 2213-2238).
 */
import type { ModelInfo } from "@shared/api"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"

export const DEEPSEEK_REASONING_EFFORT_OPTIONS = ["low", "high", "max"] as const

function thinkingCapabilities() {
	return {
		supported: true,
		mode: "effort",
		effortLevels: [...DEEPSEEK_REASONING_EFFORT_OPTIONS],
		defaultEnabled: true,
		canDisable: true,
		defaultEffort: "high",
	}
}

export const deepSeekModels: Record<string, ModelInfo> = {
	"deepseek-v4-pro": {
		id: "deepseek-v4-pro",
		name: "deepseek-v4-pro",
		capabilities: {
			supportsTools: true,
			maxTokens: 384_000,
			contextWindow: 1_000_000,
			supportsImages: false,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: thinkingCapabilities(),
			tools: [ServerTool.WEB_SEARCH],
		},
		apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT],
		pricing: {
			inputPrice: 3,
			outputPrice: 6,
			cacheWritesPrice: 3,
			cacheReadsPrice: 0.025,
			currency: "CNY",
		},
	},
	"deepseek-v4-flash": {
		id: "deepseek-v4-flash",
		name: "deepseek-v4-flash",
		capabilities: {
			supportsTools: true,
			maxTokens: 384_000,
			contextWindow: 1_000_000,
			supportsImages: false,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: thinkingCapabilities(),
			tools: [ServerTool.WEB_SEARCH],
		},
		apiFormats: [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT],
		pricing: {
			inputPrice: 1,
			outputPrice: 2,
			cacheWritesPrice: 1,
			cacheReadsPrice: 0.02,
			currency: "CNY",
		},
	},
}

/** Default model ID for DeepSeek provider */
export const deepSeekDefaultModelId = "deepseek-v4-flash"
