/**
 * Google Vertex AI provider model definitions.
 * Extracted from api.ts vertexModels (lines 997-1463).
 */
import { type ModelInfo } from "@shared/api"
import { ThinkingConfig } from "@shared/proto/dline/models/metadata"

const _sonnet_tiers = [
	{
		contextWindow: 200000,
		inputPrice: 3.0,
		outputPrice: 15,
		cacheWritesPrice: 3.75,
		cacheReadsPrice: 0.3,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 6,
		outputPrice: 22.5,
		cacheWritesPrice: 7.5,
		cacheReadsPrice: 0.6,
	},
]
const _opus_tiers = [
	{
		contextWindow: 200000,
		inputPrice: 5.0,
		outputPrice: 25,
		cacheWritesPrice: 6.25,
		cacheReadsPrice: 0.5,
	},
	{
		contextWindow: Number.MAX_SAFE_INTEGER,
		inputPrice: 10,
		outputPrice: 37.5,
		cacheWritesPrice: 12.5,
		cacheReadsPrice: 1.0,
	},
]

/**
 * Capabilities shared by the Claude generation that keeps adaptive thinking on.
 *
 * Thinking cannot be combined with a forced tool choice, so these models reject
 * `tool_choice: any` with an error rather than degrading to an automatic choice.
 * Vertex renames the models but does not change that rule, so the declaration
 * belongs here too instead of relying on the ID fallback alone.
 */
const ADAPTIVE_THINKING_CLAUDE_CAPABILITIES = { supportsForcedToolUse: false } as const

export const vertexModels: Record<string, ModelInfo> = {
	"gemini-3.1-pro-preview": {
		id: "gemini-3.1-pro-preview",

		capabilities: {
			supportsTools: true,
			maxTokens: 8192,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: { supported: true, mode: "effort", effortLevels: ["high"] },
		},
		pricing: {
			inputPrice: 2.0,
			outputPrice: 12.0,
		},
	},
	"gemini-3-pro-preview": {
		id: "gemini-3-pro-preview",

		capabilities: {
			supportsTools: true,
			maxTokens: 8192,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: { supported: true, mode: "effort", effortLevels: ["high"] },
		},
		pricing: {
			inputPrice: 2.0,
			outputPrice: 12.0,
		},
	},
	"gemini-3-flash-preview": {
		id: "gemini-3-flash-preview",

		capabilities: {
			supportsTools: true,
			maxTokens: 65536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: { supported: true, mode: "effort", effortLevels: ["high"] },
		},
		pricing: {
			inputPrice: 0.5,
			outputPrice: 3.0,
			cacheWritesPrice: 0.05,
		},
	},
	"claude-sonnet-4-6": {
		id: "claude-sonnet-4-6",
		capabilities: {
			supportsTools: true,
			maxTokens: 64_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			...ADAPTIVE_THINKING_CLAUDE_CAPABILITIES,
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
		},
	},
	"claude-sonnet-4-6:1m": {
		id: "claude-sonnet-4-6:1m",
		capabilities: {
			supportsTools: true,
			maxTokens: 64_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			...ADAPTIVE_THINKING_CLAUDE_CAPABILITIES,
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
			tiers: _sonnet_tiers,
		},
	},
	"claude-sonnet-4-5@20250929": {
		id: "claude-sonnet-4-5@20250929",
		capabilities: {
			supportsTools: true,
			maxTokens: 64_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
		},
	},
	"claude-sonnet-4@20250514": {
		id: "claude-sonnet-4@20250514",
		capabilities: {
			supportsTools: true,
			maxTokens: 64_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
		},
	},
	"claude-haiku-4-5@20251001": {
		id: "claude-haiku-4-5@20251001",
		capabilities: {
			supportsTools: true,
			maxTokens: 64_000,
			contextWindow: 200_000,
			supportsImages: false,
			supportsPromptCache: true,
			supportsReasoning: true,
		},
		pricing: {
			inputPrice: 1.0,
			outputPrice: 5.0,
			cacheWritesPrice: 1.25,
			cacheReadsPrice: 0.1,
		},
	},
	"claude-opus-4-6": {
		id: "claude-opus-4-6",
		capabilities: {
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			...ADAPTIVE_THINKING_CLAUDE_CAPABILITIES,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
	},
	"claude-opus-4-6:1m": {
		id: "claude-opus-4-6:1m",
		capabilities: {
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			...ADAPTIVE_THINKING_CLAUDE_CAPABILITIES,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
			tiers: _opus_tiers,
		},
	},
	"claude-opus-4-7": {
		id: "claude-opus-4-7",
		capabilities: {
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsGlobalEndpoint: true,
			...ADAPTIVE_THINKING_CLAUDE_CAPABILITIES,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
	},
	"claude-opus-4-7:1m": {
		id: "claude-opus-4-7:1m",
		capabilities: {
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsGlobalEndpoint: true,
			...ADAPTIVE_THINKING_CLAUDE_CAPABILITIES,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
			tiers: _opus_tiers,
		},
	},
	"claude-opus-4-5@20251101": {
		id: "claude-opus-4-5@20251101",
		capabilities: {
			supportsTools: true,
			maxTokens: 64_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
	},
	"claude-opus-4-1@20250805": {
		id: "claude-opus-4-1@20250805",
		capabilities: {
			supportsTools: true,
			maxTokens: 32_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
		},
		pricing: {
			inputPrice: 15.0,
			outputPrice: 75.0,
			cacheWritesPrice: 18.75,
			cacheReadsPrice: 1.5,
		},
	},
	"claude-opus-4@20250514": {
		id: "claude-opus-4@20250514",
		capabilities: {
			supportsTools: true,
			maxTokens: 32_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
		},
		pricing: {
			inputPrice: 15.0,
			outputPrice: 75.0,
			cacheWritesPrice: 18.75,
			cacheReadsPrice: 1.5,
		},
	},
	"claude-3-7-sonnet@20250219": {
		id: "claude-3-7-sonnet@20250219",
		capabilities: {
			maxTokens: 128_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			thinking: ThinkingConfig.create({ supported: true, mode: "budget", maxBudget: 64000 }),
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
			thinkingOutputPrice: 15.0,
		},
	},
	"claude-3-5-sonnet-v2@20241022": {
		id: "claude-3-5-sonnet-v2@20241022",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
		},
	},
	"claude-3-5-haiku@20241022": {
		id: "claude-3-5-haiku@20241022",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 0.8,
			outputPrice: 4.0,
			cacheWritesPrice: 1.0,
			cacheReadsPrice: 0.08,
		},
	},
	"claude-3-opus@20240229": {
		id: "claude-3-opus@20240229",
		capabilities: {
			maxTokens: 4096,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 15.0,
			outputPrice: 75.0,
			cacheWritesPrice: 18.75,
			cacheReadsPrice: 1.5,
		},
	},
	"claude-3-haiku@20240307": {
		id: "claude-3-haiku@20240307",
		capabilities: {
			maxTokens: 4096,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 0.25,
			outputPrice: 1.25,
			cacheWritesPrice: 0.3,
			cacheReadsPrice: 0.03,
		},
	},
	"mistral-large-2411": {
		id: "mistral-large-2411",
		capabilities: {
			maxTokens: 128_000,
			contextWindow: 128_000,
			supportsImages: false,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 2.0,
			outputPrice: 6.0,
		},
	},
	"mistral-small-2503": {
		id: "mistral-small-2503",
		capabilities: {
			maxTokens: 128_000,
			contextWindow: 128_000,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0.1,
			outputPrice: 0.3,
		},
	},
	"codestral-2501": {
		id: "codestral-2501",
		capabilities: {
			maxTokens: 256_000,
			contextWindow: 256_000,
			supportsImages: false,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0.3,
			outputPrice: 0.9,
		},
	},
	"llama-4-maverick-17b-128e-instruct-maas": {
		id: "llama-4-maverick-17b-128e-instruct-maas",
		capabilities: {
			maxTokens: 128_000,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0.35,
			outputPrice: 1.15,
		},
	},
	"llama-4-scout-17b-16e-instruct-maas": {
		id: "llama-4-scout-17b-16e-instruct-maas",
		capabilities: {
			maxTokens: 1_000_000,
			contextWindow: 10_485_760,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0.25,
			outputPrice: 0.7,
		},
	},
	"gemini-2.0-flash-001": {
		id: "gemini-2.0-flash-001",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 0.15,
			outputPrice: 0.6,
			cacheWritesPrice: 1.0,
			cacheReadsPrice: 0.025,
		},
	},
	"gemini-2.0-flash-lite-001": {
		id: "gemini-2.0-flash-lite-001",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0.075,
			outputPrice: 0.3,
		},
	},
	"gemini-2.0-flash-thinking-exp-1219": {
		id: "gemini-2.0-flash-thinking-exp-1219",
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
	"gemini-2.5-pro-exp-03-25": {
		id: "gemini-2.5-pro-exp-03-25",
		capabilities: {
			supportsTools: true,
			maxTokens: 65536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0,
			outputPrice: 0,
		},
	},
	"gemini-2.5-pro": {
		id: "gemini-2.5-pro",
		capabilities: {
			supportsTools: true,
			maxTokens: 65536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			thinking: ThinkingConfig.create({ supported: true, mode: "budget", maxBudget: 32767 }),
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
	"gemini-2.5-flash": {
		id: "gemini-2.5-flash",
		capabilities: {
			supportsTools: true,
			maxTokens: 65536,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
			thinking: ThinkingConfig.create({ supported: true, mode: "budget", maxBudget: 24576 }),
		},
		pricing: {
			inputPrice: 0.3,
			outputPrice: 2.5,
			thinkingOutputPrice: 3.5,
		},
	},
	"gemini-2.5-flash-lite-preview-06-17": {
		id: "gemini-2.5-flash-lite-preview-06-17",
		description: "Preview version - may not be available in all regions",
		capabilities: {
			supportsTools: true,
			maxTokens: 64000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			thinking: ThinkingConfig.create({ supported: true, mode: "budget", maxBudget: 24576 }),
		},
		pricing: {
			inputPrice: 0.1,
			outputPrice: 0.4,
			cacheReadsPrice: 0.025,
		},
	},
	"gemini-2.0-flash-thinking-exp-01-21": {
		id: "gemini-2.0-flash-thinking-exp-01-21",
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
	"gemini-exp-1206": {
		id: "gemini-exp-1206",
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
	"gemini-1.5-flash-002": {
		id: "gemini-1.5-flash-002",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 1_048_576,
			supportsImages: true,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 0.15,
			outputPrice: 0.6,
			cacheWritesPrice: 1.0,
			cacheReadsPrice: 0.0375,
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
		capabilities: {
			maxTokens: 8192,
			contextWindow: 2_097_152,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 1.25,
			outputPrice: 5,
		},
	},
	"gemini-1.5-pro-exp-0827": {
		id: "gemini-1.5-pro-exp-0827",
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

/** Default model ID for Vertex AI provider */
export const vertexDefaultModelId = "gemini-3-pro-preview"

/**
 * Vertex models filtered to those supporting global endpoint.
 * Stored as a pre-filtered map for fast lookups.
 */
export const vertexGlobalModels: Record<string, ModelInfo> = Object.fromEntries(
	Object.entries(vertexModels)
		.filter(([, model]) => model.capabilities?.supportsGlobalEndpoint)
		.map(([id, model]) => [id, model as ModelInfo]),
)
