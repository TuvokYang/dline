/**
 * AWS Bedrock provider model definitions.
 * Extracted from api.ts bedrockModels (lines 532-997).
 */
import type { ModelInfo } from "@shared/api"
import type { ContextWindowBand, ThinkingConfig } from "@shared/proto/dline/models/metadata"
import {
    ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS,
    ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH,
    adaptiveThinkingCapabilities,
} from "./anthropic"
import { band, bandedPricing, flatPricing } from "./pricing"

const CLAUDE_BUDGET_THINKING: ThinkingConfig = {
    supported: true,
    mode: "budget",
    minBudget: 1024,
    defaultEnabled: false,
    canDisable: true,
}

// Inlined from api.ts: CLAUDE_SONNET_1M_TIERS
const CLAUDE_SONNET_1M_TIERS: readonly ContextWindowBand[] = [
    band(200_000, 3.0, 15, 3.75, 0.3),
    band(undefined, 6, 22.5, 7.5, 0.6),
]

// Inlined from api.ts: CLAUDE_OPUS_1M_TIERS
const CLAUDE_OPUS_1M_TIERS: readonly ContextWindowBand[] = [
    band(200_000, 5.0, 25, 6.25, 0.5),
    band(undefined, 10, 37.5, 12.5, 1.0),
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
        pricing: flatPricing(3.0, 15.0, 3.75, 0.3),
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
        pricing: bandedPricing(CLAUDE_SONNET_1M_TIERS),
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
        pricing: flatPricing(3.0, 15.0, 3.75, 0.3),
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
        pricing: bandedPricing(CLAUDE_SONNET_1M_TIERS),
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
        pricing: flatPricing(1, 5.0, 1.25, 0.1),
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
        pricing: flatPricing(3.0, 15.0, 3.75, 0.3),
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
        pricing: bandedPricing(CLAUDE_SONNET_1M_TIERS),
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
        pricing: flatPricing(5.0, 25.0, 6.25, 0.5),
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
        pricing: bandedPricing(CLAUDE_OPUS_1M_TIERS),
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
        pricing: flatPricing(5.0, 25.0, 6.25, 0.5),
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
        pricing: bandedPricing(CLAUDE_OPUS_1M_TIERS),
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
        pricing: flatPricing(5.0, 25.0, 6.25, 0.5),
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
        pricing: flatPricing(15.0, 75.0, 18.75, 1.5),
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
        pricing: flatPricing(15.0, 75.0, 18.75, 1.5),
    },
    "amazon.nova-premier-v1:0": {
        id: "amazon.nova-premier-v1:0",
        capabilities: {
            maxTokens: 10_000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(2.5, 12.5),
    },
    "amazon.nova-pro-v1:0": {
        id: "amazon.nova-pro-v1:0",
        capabilities: {
            maxTokens: 5000,
            contextWindow: 300_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: flatPricing(0.8, 3.2, undefined, 0.2),
    },
    "amazon.nova-lite-v1:0": {
        id: "amazon.nova-lite-v1:0",
        capabilities: {
            maxTokens: 5000,
            contextWindow: 300_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: flatPricing(0.06, 0.24, undefined, 0.015),
    },
    "amazon.nova-2-lite-v1:0": {
        id: "amazon.nova-2-lite-v1:0",
        capabilities: {
            maxTokens: 5000,
            contextWindow: 1_000_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: flatPricing(0.3, 2.5, undefined, 0.075),
    },
    "amazon.nova-micro-v1:0": {
        id: "amazon.nova-micro-v1:0",
        capabilities: {
            maxTokens: 5000,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: true,
        },
        pricing: flatPricing(0.035, 0.14, undefined, 0.00875),
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
        pricing: flatPricing(3.0, 15.0, 3.75, 0.3),
    },
    "anthropic.claude-3-5-sonnet-20241022-v2:0": {
        id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: flatPricing(3.0, 15.0, 3.75, 0.3),
    },
    "anthropic.claude-3-5-haiku-20241022-v1:0": {
        id: "anthropic.claude-3-5-haiku-20241022-v1:0",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: flatPricing(0.8, 4.0, 1.0, 0.08),
    },
    "anthropic.claude-3-5-sonnet-20240620-v1:0": {
        id: "anthropic.claude-3-5-sonnet-20240620-v1:0",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(3.0, 15.0),
    },
    "anthropic.claude-3-opus-20240229-v1:0": {
        id: "anthropic.claude-3-opus-20240229-v1:0",
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(15.0, 75.0),
    },
    "anthropic.claude-3-sonnet-20240229-v1:0": {
        id: "anthropic.claude-3-sonnet-20240229-v1:0",
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(3.0, 15.0),
    },
    "anthropic.claude-3-haiku-20240307-v1:0": {
        id: "anthropic.claude-3-haiku-20240307-v1:0",
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0.25, 1.25),
    },
    "deepseek.r1-v1:0": {
        id: "deepseek.r1-v1:0",
        capabilities: {
            maxTokens: 8_000,
            contextWindow: 64_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: flatPricing(1.35, 5.4),
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
        pricing: flatPricing(0.15, 0.6),
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
        pricing: flatPricing(0.07, 0.3),
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
        pricing: flatPricing(0.15, 0.6),
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
        pricing: flatPricing(0.22, 1.8),
    },
}

/** Default model ID for Bedrock provider */
export const bedrockDefaultModelId = "anthropic.claude-sonnet-4-5-20250929-v1:0"
