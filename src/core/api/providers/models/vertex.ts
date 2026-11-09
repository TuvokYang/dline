/**
 * Google Vertex AI provider model definitions.
 * Extracted from api.ts vertexModels (lines 997-1463).
 */
import { type ModelInfo } from "@shared/api"
import { type ContextWindowBand, ThinkingConfig } from "@shared/proto/dline/models/metadata"
import {
    ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS,
    ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH,
    adaptiveThinkingCapabilities,
} from "./anthropic"
import { band, bandedPricing, flatPricing } from "./pricing"

const _sonnet_tiers: readonly ContextWindowBand[] = [band(200_000, 3.0, 15, 3.75, 0.3), band(undefined, 6, 22.5, 7.5, 0.6)]
const _opus_tiers: readonly ContextWindowBand[] = [band(200_000, 5.0, 25, 6.25, 0.5), band(undefined, 10, 37.5, 12.5, 1.0)]

const ADAPTIVE_THINKING_CLAUDE_CAPABILITIES = adaptiveThinkingCapabilities(
    ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS_WITHOUT_XHIGH,
)
const CLAUDE_BUDGET_THINKING: ThinkingConfig = {
    supported: true,
    mode: "budget",
    minBudget: 1024,
    defaultEnabled: false,
    canDisable: true,
}

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
            thinking: {
                supported: true,
                mode: "effort",
                effortLevels: ["low", "medium", "high"],
                defaultEnabled: true,
                defaultEffort: "high",
                canDisable: false,
            },
        },
        pricing: flatPricing(2.0, 12.0),
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
            thinking: {
                supported: true,
                mode: "effort",
                effortLevels: ["low", "high"],
                defaultEnabled: true,
                defaultEffort: "high",
                canDisable: false,
            },
        },
        pricing: flatPricing(2.0, 12.0),
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
            thinking: {
                supported: true,
                mode: "effort",
                effortLevels: ["minimal", "low", "medium", "high"],
                defaultEnabled: true,
                defaultEffort: "high",
                canDisable: false,
            },
        },
        pricing: flatPricing(0.5, 3.0, 0.05),
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
        pricing: flatPricing(3.0, 15.0, 3.75, 0.3),
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
        pricing: bandedPricing(_sonnet_tiers),
    },
    "claude-sonnet-4-5@20250929": {
        id: "claude-sonnet-4-5@20250929",
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
    "claude-sonnet-4@20250514": {
        id: "claude-sonnet-4@20250514",
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
    "claude-haiku-4-5@20251001": {
        id: "claude-haiku-4-5@20251001",
        capabilities: {
            thinking: { ...CLAUDE_BUDGET_THINKING },
            supportsTools: true,
            maxTokens: 64_000,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: true,
            supportsReasoning: true,
        },
        pricing: flatPricing(1.0, 5.0, 1.25, 0.1),
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
        pricing: flatPricing(5.0, 25.0, 6.25, 0.5),
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
        pricing: bandedPricing(_opus_tiers),
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
            ...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
        },
        pricing: flatPricing(5.0, 25.0, 6.25, 0.5),
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
            ...adaptiveThinkingCapabilities(ANTHROPIC_ADAPTIVE_REASONING_EFFORT_OPTIONS),
        },
        pricing: bandedPricing(_opus_tiers),
    },
    "claude-opus-4-5@20251101": {
        id: "claude-opus-4-5@20251101",
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
    "claude-opus-4-1@20250805": {
        id: "claude-opus-4-1@20250805",
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
    "claude-opus-4@20250514": {
        id: "claude-opus-4@20250514",
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
    "claude-3-7-sonnet@20250219": {
        id: "claude-3-7-sonnet@20250219",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
            supportsReasoning: true,
            thinking: ThinkingConfig.create({ ...CLAUDE_BUDGET_THINKING, maxBudget: 64000 }),
        },
        pricing: flatPricing(3.0, 15.0, 3.75, 0.3, "USD", 15.0),
    },
    "claude-3-5-sonnet-v2@20241022": {
        id: "claude-3-5-sonnet-v2@20241022",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: flatPricing(3.0, 15.0, 3.75, 0.3),
    },
    "claude-3-5-haiku@20241022": {
        id: "claude-3-5-haiku@20241022",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: flatPricing(0.8, 4.0, 1.0, 0.08),
    },
    "claude-3-opus@20240229": {
        id: "claude-3-opus@20240229",
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: flatPricing(15.0, 75.0, 18.75, 1.5),
    },
    "claude-3-haiku@20240307": {
        id: "claude-3-haiku@20240307",
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: flatPricing(0.25, 1.25, 0.3, 0.03),
    },
    "mistral-large-2411": {
        id: "mistral-large-2411",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: flatPricing(2.0, 6.0),
    },
    "mistral-small-2503": {
        id: "mistral-small-2503",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 128_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0.1, 0.3),
    },
    "codestral-2501": {
        id: "codestral-2501",
        capabilities: {
            maxTokens: 256_000,
            contextWindow: 256_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0.3, 0.9),
    },
    "llama-4-maverick-17b-128e-instruct-maas": {
        id: "llama-4-maverick-17b-128e-instruct-maas",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 1_048_576,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0.35, 1.15),
    },
    "llama-4-scout-17b-16e-instruct-maas": {
        id: "llama-4-scout-17b-16e-instruct-maas",
        capabilities: {
            maxTokens: 1_000_000,
            contextWindow: 10_485_760,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0.25, 0.7),
    },
    "gemini-2.0-flash-001": {
        id: "gemini-2.0-flash-001",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 1_048_576,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: flatPricing(0.15, 0.6, 1.0, 0.025),
    },
    "gemini-2.0-flash-lite-001": {
        id: "gemini-2.0-flash-lite-001",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 1_048_576,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0.075, 0.3),
    },
    "gemini-2.0-flash-thinking-exp-1219": {
        id: "gemini-2.0-flash-thinking-exp-1219",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 32_767,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0, 0),
    },
    "gemini-2.0-flash-exp": {
        id: "gemini-2.0-flash-exp",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 1_048_576,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0, 0),
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
        pricing: flatPricing(0, 0),
    },
    "gemini-2.5-pro": {
        id: "gemini-2.5-pro",
        capabilities: {
            supportsTools: true,
            maxTokens: 65536,
            contextWindow: 1_048_576,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({
                supported: true,
                mode: "budget",
                maxBudget: 32768,
                minBudget: 128,
                defaultEnabled: true,
                canDisable: false,
            }),
        },
        pricing: bandedPricing([band(200_000, 1.25, 10, undefined, 0.31), band(undefined, 2.5, 15, undefined, 0.625)]),
    },
    "gemini-2.5-flash": {
        id: "gemini-2.5-flash",
        capabilities: {
            supportsTools: true,
            maxTokens: 65536,
            contextWindow: 1_048_576,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({
                supported: true,
                mode: "budget",
                maxBudget: 24576,
                minBudget: 1,
                defaultEnabled: true,
                canDisable: true,
            }),
        },
        pricing: flatPricing(0.3, 2.5, undefined, undefined, "USD", 3.5),
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
            thinking: ThinkingConfig.create({
                supported: true,
                mode: "budget",
                maxBudget: 24576,
                defaultEnabled: false,
                canDisable: true,
            }),
        },
        pricing: flatPricing(0.1, 0.4, undefined, 0.025),
    },
    "gemini-2.0-flash-thinking-exp-01-21": {
        id: "gemini-2.0-flash-thinking-exp-01-21",
        capabilities: {
            maxTokens: 65_536,
            contextWindow: 1_048_576,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0, 0),
    },
    "gemini-exp-1206": {
        id: "gemini-exp-1206",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 2_097_152,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0, 0),
    },
    "gemini-1.5-flash-002": {
        id: "gemini-1.5-flash-002",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 1_048_576,
            supportsImages: true,
            supportsPromptCache: true,
        },
        pricing: bandedPricing([band(128_000, 0.075, 0.3, 1.0, 0.01875), band(undefined, 0.15, 0.6, 1.0, 0.0375)]),
    },
    "gemini-1.5-flash-exp-0827": {
        id: "gemini-1.5-flash-exp-0827",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 1_048_576,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0, 0),
    },
    "gemini-1.5-flash-8b-exp-0827": {
        id: "gemini-1.5-flash-8b-exp-0827",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 1_048_576,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0, 0),
    },
    "gemini-1.5-pro-002": {
        id: "gemini-1.5-pro-002",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 2_097_152,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(1.25, 5),
    },
    "gemini-1.5-pro-exp-0827": {
        id: "gemini-1.5-pro-exp-0827",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 2_097_152,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: flatPricing(0, 0),
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
