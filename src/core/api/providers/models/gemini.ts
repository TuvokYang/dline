/**
 * Google Gemini provider model definitions.
 * Extracted from api.ts geminiModels (lines 1484-1737).
 */
import { type ModelInfo } from "@shared/api"
import { ThinkingConfig } from "@shared/proto/dline/models/metadata"

export const geminiModels: Record<string, ModelInfo> = {
	"gemini-3.1-pro-preview": {
		id: "gemini-3.1-pro-preview",
		name: "gemini-3.1-pro-preview",
		capabilities: {
			supportsTools: true,
			maxTokens: 65536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			thinking: {
				supported: true,
				mode: "effort",
				effortLevels: ["low", "medium", "high"],
				defaultEnabled: true,
				defaultEffort: "high",
				canDisable: false,
			},
		},
		pricing: {
			inputPrice: 4.0,
			outputPrice: 18.0,
			cacheReadsPrice: 0.4,
			tiers: [
				{
					contextWindow: 200000,
					inputPrice: 2.0,
					outputPrice: 12.0,
					cacheReadsPrice: 0.2,
				},
				{
					contextWindow: Number.POSITIVE_INFINITY,
					inputPrice: 4.0,
					outputPrice: 18.0,
					cacheReadsPrice: 0.4,
				},
			],
		},
	},
	"gemini-3-pro-preview": {
		id: "gemini-3-pro-preview",
		name: "gemini-3-pro-preview",
		capabilities: {
			supportsTools: true,
			maxTokens: 65536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			thinking: {
				supported: true,
				mode: "effort",
				effortLevels: ["low", "high"],
				defaultEnabled: true,
				defaultEffort: "high",
				canDisable: false,
			},
		},
		pricing: {
			inputPrice: 4.0,
			outputPrice: 18.0,
			cacheReadsPrice: 0.4,
			tiers: [
				{
					contextWindow: 200000,
					inputPrice: 2.0,
					outputPrice: 12.0,
					cacheReadsPrice: 0.2,
				},
				{
					contextWindow: Number.POSITIVE_INFINITY,
					inputPrice: 4.0,
					outputPrice: 18.0,
					cacheReadsPrice: 0.4,
				},
			],
		},
	},
	"gemini-3-flash-preview": {
		id: "gemini-3-flash-preview",
		name: "gemini-3-flash-preview",
		capabilities: {
			supportsTools: true,
			maxTokens: 65536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: {
				supported: true,
				mode: "effort",
				effortLevels: ["minimal", "low", "medium", "high"],
				defaultEnabled: true,
				defaultEffort: "high",
				canDisable: false,
			},
		},
		pricing: {
			inputPrice: 0.5,
			outputPrice: 3.0,
			cacheWritesPrice: 0.05,
			tiers: [
				{
					contextWindow: 200000,
					inputPrice: 0.3,
					outputPrice: 2.5,
					cacheReadsPrice: 0.03,
				},
				{
					contextWindow: Number.POSITIVE_INFINITY,
					inputPrice: 0.3,
					outputPrice: 2.5,
					cacheReadsPrice: 0.03,
				},
			],
		},
	},
	"gemini-2.5-pro": {
		id: "gemini-2.5-pro",
		name: "gemini-2.5-pro",
		capabilities: {
			supportsTools: true,
			maxTokens: 65536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			thinking: ThinkingConfig.create({
				maxBudget: 32768,
				minBudget: 128,
				supported: true,
				mode: "budget",
				defaultEnabled: true,
				canDisable: false,
			}),
		},
		pricing: {
			inputPrice: 2.5,
			outputPrice: 15,
			cacheReadsPrice: 0.625,
			tiers: [
				{
					contextWindow: 200000,
					inputPrice: 1.25,
					outputPrice: 10,
					cacheReadsPrice: 0.31,
				},
				{
					contextWindow: Number.POSITIVE_INFINITY,
					inputPrice: 2.5,
					outputPrice: 15,
					cacheReadsPrice: 0.625,
				},
			],
		},
	},
	"gemini-2.5-flash-lite-preview-06-17": {
		id: "gemini-2.5-flash-lite-preview-06-17",
		name: "gemini-2.5-flash-lite-preview-06-17",
		description: "Preview version - may not be available in all regions",
		capabilities: {
			supportsTools: true,
			maxTokens: 64000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			thinking: ThinkingConfig.create({
				maxBudget: 24576,
				supported: true,
				mode: "budget",
				defaultEnabled: false,
				canDisable: true,
			}),
		},
		pricing: {
			inputPrice: 0.1,
			outputPrice: 0.4,
			cacheReadsPrice: 0.025,
		},
	},
	"gemini-2.5-flash": {
		id: "gemini-2.5-flash",
		name: "gemini-2.5-flash",
		capabilities: {
			supportsTools: true,
			maxTokens: 65536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			thinking: ThinkingConfig.create({
				maxBudget: 24576,
				minBudget: 0,
				supported: true,
				mode: "budget",
				defaultEnabled: true,
				canDisable: true,
			}),
		},
		pricing: {
			inputPrice: 0.3,
			outputPrice: 2.5,
			cacheReadsPrice: 0.075,
			thinkingOutputPrice: 3.5,
		},
	},
	"gemini-2.0-flash-001": {
		id: "gemini-2.0-flash-001",
		name: "gemini-2.0-flash-001",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 0.1,
			outputPrice: 0.4,
			cacheReadsPrice: 0.025,
			cacheWritesPrice: 1.0,
		},
	},
	"gemini-2.0-flash-lite-preview-02-05": {
		id: "gemini-2.0-flash-lite-preview-02-05",
		name: "gemini-2.0-flash-lite-preview-02-05",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0,
			outputPrice: 0,
		},
	},
	"gemini-2.0-pro-exp-02-05": {
		id: "gemini-2.0-pro-exp-02-05",
		name: "gemini-2.0-pro-exp-02-05",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 2_097_152,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0,
			outputPrice: 0,
		},
	},
	"gemini-2.0-flash-thinking-exp-01-21": {
		id: "gemini-2.0-flash-thinking-exp-01-21",
		name: "gemini-2.0-flash-thinking-exp-01-21",
		capabilities: {
			maxTokens: 65_536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0,
			outputPrice: 0,
		},
	},
	"gemini-2.0-flash-thinking-exp-1219": {
		id: "gemini-2.0-flash-thinking-exp-1219",
		name: "gemini-2.0-flash-thinking-exp-1219",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 32_767,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0,
			outputPrice: 0,
		},
	},
	"gemini-2.0-flash-exp": {
		id: "gemini-2.0-flash-exp",
		name: "gemini-2.0-flash-exp",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0,
			outputPrice: 0,
		},
	},
	"gemini-1.5-flash-002": {
		id: "gemini-1.5-flash-002",
		name: "gemini-1.5-flash-002",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 0.15,
			outputPrice: 0.6,
			cacheReadsPrice: 0.0375,
			cacheWritesPrice: 1.0,
			tiers: [
				{
					contextWindow: 128000,
					inputPrice: 0.075,
					outputPrice: 0.3,
					cacheReadsPrice: 0.01875,
				},
				{
					contextWindow: Number.POSITIVE_INFINITY,
					inputPrice: 0.15,
					outputPrice: 0.6,
					cacheReadsPrice: 0.0375,
				},
			],
		},
	},
	"gemini-1.5-flash-exp-0827": {
		id: "gemini-1.5-flash-exp-0827",
		name: "gemini-1.5-flash-exp-0827",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0,
			outputPrice: 0,
		},
	},
	"gemini-1.5-flash-8b-exp-0827": {
		id: "gemini-1.5-flash-8b-exp-0827",
		name: "gemini-1.5-flash-8b-exp-0827",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0,
			outputPrice: 0,
		},
	},
	"gemini-1.5-pro-002": {
		id: "gemini-1.5-pro-002",
		name: "gemini-1.5-pro-002",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 2_097_152,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0,
			outputPrice: 0,
		},
	},
	"gemini-1.5-pro-exp-0827": {
		id: "gemini-1.5-pro-exp-0827",
		name: "gemini-1.5-pro-exp-0827",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 2_097_152,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0,
			outputPrice: 0,
		},
	},
	"gemini-exp-1206": {
		id: "gemini-exp-1206",
		name: "gemini-exp-1206",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 2_097_152,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0,
			outputPrice: 0,
		},
	},
}

/** Default model ID for Gemini provider */
export const geminiDefaultModelId = "gemini-3.1-pro-preview"
