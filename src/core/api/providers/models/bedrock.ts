/**
 * AWS Bedrock provider model definitions.
 * Extracted from api.ts bedrockModels (lines 532-997).
 */
import type { ModelInfo } from "@shared/api"
import type { ThinkingConfig } from "@shared/proto/dline/models/metadata"
import {
	ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS,
	ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH,
	adaptiveThinkingCapabilities,
} from "./anthropic"

const CLAUDE_BUDGET_THINKING: ThinkingConfig = { supported: true, mode: "budget", defaultEnabled: false, canDisable: true }

// Inlined from api.ts: CLAUDE_SONNET_1M_TIERS
const CLAUDE_SONNET_1M_TIERS = [
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

// Inlined from api.ts: CLAUDE_OPUS_1M_TIERS
const CLAUDE_OPUS_1M_TIERS = [
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

export const bedrockModels: Record<string, ModelInfo> = {
	"anthropic.claude-sonnet-4-6": {
		id: "anthropic.claude-sonnet-4-6",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH),
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
	"anthropic.claude-sonnet-4-6:1m": {
		id: "anthropic.claude-sonnet-4-6:1m",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH),
			supportsTools: true,
			maxTokens: 64_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
			tiers: CLAUDE_SONNET_1M_TIERS,
		},
	},
	"anthropic.claude-sonnet-4-5-20250929-v1:0": {
		id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
		capabilities: {
			thinking: { ...CLAUDE_BUDGET_THINKING },
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
	"anthropic.claude-sonnet-4-5-20250929-v1:0:1m": {
		id: "anthropic.claude-sonnet-4-5-20250929-v1:0:1m",
		capabilities: {
			thinking: { ...CLAUDE_BUDGET_THINKING },
			supportsTools: true,
			maxTokens: 64_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
			tiers: CLAUDE_SONNET_1M_TIERS,
		},
	},
	"anthropic.claude-haiku-4-5-20251001-v1:0": {
		id: "anthropic.claude-haiku-4-5-20251001-v1:0",
		capabilities: {
			thinking: { ...CLAUDE_BUDGET_THINKING },
			supportsTools: true,
			maxTokens: 64_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
		},
		pricing: {
			inputPrice: 1,
			outputPrice: 5.0,
			cacheWritesPrice: 1.25,
			cacheReadsPrice: 0.1,
		},
	},
	"anthropic.claude-sonnet-4-20250514-v1:0": {
		id: "anthropic.claude-sonnet-4-20250514-v1:0",
		capabilities: {
			thinking: { ...CLAUDE_BUDGET_THINKING },
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
	"anthropic.claude-sonnet-4-20250514-v1:0:1m": {
		id: "anthropic.claude-sonnet-4-20250514-v1:0:1m",
		capabilities: {
			thinking: { ...CLAUDE_BUDGET_THINKING },
			supportsTools: true,
			maxTokens: 64_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
			cacheWritesPrice: 3.75,
			cacheReadsPrice: 0.3,
			tiers: CLAUDE_SONNET_1M_TIERS,
		},
	},
	"anthropic.claude-opus-4-6-v1": {
		id: "anthropic.claude-opus-4-6-v1",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH),
			supportsTools: true,
			maxTokens: 128_000,
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
	"anthropic.claude-opus-4-6-v1:1m": {
		id: "anthropic.claude-opus-4-6-v1:1m",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH),
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
			tiers: CLAUDE_OPUS_1M_TIERS,
		},
	},
	"anthropic.claude-opus-4-7": {
		id: "anthropic.claude-opus-4-7",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsGlobalEndpoint: true,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
		},
	},
	"anthropic.claude-opus-4-7:1m": {
		id: "anthropic.claude-opus-4-7:1m",
		capabilities: {
			...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
			supportsTools: true,
			maxTokens: 128_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
			supportsReasoning: true,
			supportsGlobalEndpoint: true,
		},
		pricing: {
			inputPrice: 5.0,
			outputPrice: 25.0,
			cacheWritesPrice: 6.25,
			cacheReadsPrice: 0.5,
			tiers: CLAUDE_OPUS_1M_TIERS,
		},
	},
	"anthropic.claude-opus-4-5-20251101-v1:0": {
		id: "anthropic.claude-opus-4-5-20251101-v1:0",
		capabilities: {
			thinking: { ...CLAUDE_BUDGET_THINKING },
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
	"anthropic.claude-opus-4-20250514-v1:0": {
		id: "anthropic.claude-opus-4-20250514-v1:0",
		capabilities: {
			thinking: { ...CLAUDE_BUDGET_THINKING },
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
	"anthropic.claude-opus-4-1-20250805-v1:0": {
		id: "anthropic.claude-opus-4-1-20250805-v1:0",
		capabilities: {
			thinking: { ...CLAUDE_BUDGET_THINKING },
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
	"amazon.nova-premier-v1:0": {
		id: "amazon.nova-premier-v1:0",
		capabilities: {
			maxTokens: 10_000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 2.5,
			outputPrice: 12.5,
		},
	},
	"amazon.nova-pro-v1:0": {
		id: "amazon.nova-pro-v1:0",
		capabilities: {
			maxTokens: 5000,
			contextWindow: 300_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 0.8,
			outputPrice: 3.2,
			cacheReadsPrice: 0.2,
		},
	},
	"amazon.nova-lite-v1:0": {
		id: "amazon.nova-lite-v1:0",
		capabilities: {
			maxTokens: 5000,
			contextWindow: 300_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 0.06,
			outputPrice: 0.24,
			cacheReadsPrice: 0.015,
		},
	},
	"amazon.nova-2-lite-v1:0": {
		id: "amazon.nova-2-lite-v1:0",
		capabilities: {
			maxTokens: 5000,
			contextWindow: 1_000_000,
			supportsImages: true,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 0.3,
			outputPrice: 2.5,
			cacheReadsPrice: 0.075,
		},
	},
	"amazon.nova-micro-v1:0": {
		id: "amazon.nova-micro-v1:0",
		capabilities: {
			maxTokens: 5000,
			contextWindow: 128_000,
			supportsImages: false,
			supportsPromptCache: true,
		},
		pricing: {
			inputPrice: 0.035,
			outputPrice: 0.14,
			cacheReadsPrice: 0.00875,
		},
	},
	"anthropic.claude-3-7-sonnet-20250219-v1:0": {
		id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
		capabilities: {
			thinking: { ...CLAUDE_BUDGET_THINKING },
			maxTokens: 128_000,
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
	"anthropic.claude-3-5-sonnet-20241022-v2:0": {
		id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
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
	"anthropic.claude-3-5-haiku-20241022-v1:0": {
		id: "anthropic.claude-3-5-haiku-20241022-v1:0",
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
	"anthropic.claude-3-5-sonnet-20240620-v1:0": {
		id: "anthropic.claude-3-5-sonnet-20240620-v1:0",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
		},
	},
	"anthropic.claude-3-opus-20240229-v1:0": {
		id: "anthropic.claude-3-opus-20240229-v1:0",
		capabilities: {
			maxTokens: 4096,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 15.0,
			outputPrice: 75.0,
		},
	},
	"anthropic.claude-3-sonnet-20240229-v1:0": {
		id: "anthropic.claude-3-sonnet-20240229-v1:0",
		capabilities: {
			maxTokens: 4096,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 3.0,
			outputPrice: 15.0,
		},
	},
	"anthropic.claude-3-haiku-20240307-v1:0": {
		id: "anthropic.claude-3-haiku-20240307-v1:0",
		capabilities: {
			maxTokens: 4096,
			contextWindow: 200_000,
			supportsImages: true,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0.25,
			outputPrice: 1.25,
		},
	},
	"deepseek.r1-v1:0": {
		id: "deepseek.r1-v1:0",
		capabilities: {
			maxTokens: 8_000,
			contextWindow: 64_000,
			supportsImages: false,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 1.35,
			outputPrice: 5.4,
		},
	},
	"openai.gpt-oss-120b-1:0": {
		id: "openai.gpt-oss-120b-1:0",
		name: "openai.gpt-oss-120b-1:0",
		description:
			"A state-of-the-art 120B open-weight Mixture-of-Experts language model optimized for strong reasoning, tool use, and efficient deployment on large GPUs",
		capabilities: {
			supportsTools: true,
			maxTokens: 8192,
			contextWindow: 128_000,
			supportsImages: false,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0.15,
			outputPrice: 0.6,
		},
	},
	"openai.gpt-oss-20b-1:0": {
		id: "openai.gpt-oss-20b-1:0",
		name: "openai.gpt-oss-20b-1:0",
		description:
			"A compact 20B open-weight Mixture-of-Experts language model designed for strong reasoning and tool use, ideal for edge devices and local inference.",
		capabilities: {
			supportsTools: true,
			maxTokens: 8192,
			contextWindow: 128_000,
			supportsImages: false,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0.07,
			outputPrice: 0.3,
		},
	},
	"qwen.qwen3-coder-30b-a3b-v1:0": {
		id: "qwen.qwen3-coder-30b-a3b-v1:0",
		name: "qwen.qwen3-coder-30b-a3b-v1:0",
		description:
			"Qwen3 Coder 30B MoE model with 3.3B activated parameters, optimized for code generation and analysis with 256K context window.",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 262_144,
			supportsImages: false,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0.15,
			outputPrice: 0.6,
		},
	},
	"qwen.qwen3-coder-480b-a35b-v1:0": {
		id: "qwen.qwen3-coder-480b-a35b-v1:0",
		name: "qwen.qwen3-coder-480b-a35b-v1:0",
		description:
			"Qwen3 Coder 480B flagship MoE model with 35B activated parameters, designed for complex coding tasks with advanced reasoning capabilities and 256K context window.",
		capabilities: {
			maxTokens: 8192,
			contextWindow: 262_144,
			supportsImages: false,
			supportsPromptCache: false,
		},
		pricing: {
			inputPrice: 0.22,
			outputPrice: 1.8,
		},
	},
}

/** Default model ID for Bedrock provider */
export const bedrockDefaultModelId = "anthropic.claude-sonnet-4-5-20250929-v1:0"
