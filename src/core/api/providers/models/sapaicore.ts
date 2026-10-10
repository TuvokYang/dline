/**
 * SAP AI Core provider model definitions.
 * Extracted from api.ts sapAiCoreModels (lines 4167-4387).
 */
import { type ModelInfo } from "@shared/api"
import { ThinkingConfig } from "@shared/proto/dline/models/metadata"

const DESC = "Pricing is calculated using SAP's Capacity Units rather than direct USD pricing."

export const sapAiCoreModels: Record<string, ModelInfo> = {
    "anthropic--claude-4.5-haiku": {
        id: "anthropic--claude-4.5-haiku",
        name: "anthropic--claude-4.5-haiku",
        description: DESC,
        capabilities: {
            maxTokens: 64000,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "anthropic--claude-4.6-sonnet": {
        id: "anthropic--claude-4.6-sonnet",
        name: "anthropic--claude-4.6-sonnet",
        description: DESC,
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "anthropic--claude-4.5-sonnet": {
        id: "anthropic--claude-4.5-sonnet",
        name: "anthropic--claude-4.5-sonnet",
        description: DESC,
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "anthropic--claude-4-sonnet": {
        id: "anthropic--claude-4-sonnet",
        name: "anthropic--claude-4-sonnet",
        description: DESC,
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "anthropic--claude-4.5-opus": {
        id: "anthropic--claude-4.5-opus",
        name: "anthropic--claude-4.5-opus",
        description: DESC,
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "anthropic--claude-4-opus": {
        id: "anthropic--claude-4-opus",
        name: "anthropic--claude-4-opus",
        description: DESC,
        capabilities: {
            maxTokens: 32_000,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "anthropic--claude-3.7-sonnet": {
        id: "anthropic--claude-3.7-sonnet",
        name: "anthropic--claude-3.7-sonnet",
        description: DESC,
        capabilities: {
            maxTokens: 64_000,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "anthropic--claude-3.5-sonnet": {
        id: "anthropic--claude-3.5-sonnet",
        name: "anthropic--claude-3.5-sonnet",
        description: DESC,
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
    },
    "anthropic--claude-3-sonnet": {
        id: "anthropic--claude-3-sonnet",
        name: "anthropic--claude-3-sonnet",
        description: DESC,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
    },
    "anthropic--claude-3-haiku": {
        id: "anthropic--claude-3-haiku",
        name: "anthropic--claude-3-haiku",
        description: DESC,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
    },
    "anthropic--claude-3-opus": {
        id: "anthropic--claude-3-opus",
        name: "anthropic--claude-3-opus",
        description: DESC,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
    },
    "gemini-2.5-pro": {
        id: "gemini-2.5-pro",
        name: "gemini-2.5-pro",
        description: DESC,
        capabilities: {
            maxTokens: 65536,
            contextWindow: 1_048_576,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ supported: true, mode: "budget", maxBudget: 32767 }),
        },
    },
    "gemini-2.5-flash": {
        id: "gemini-2.5-flash",
        name: "gemini-2.5-flash",
        description: DESC,
        capabilities: {
            maxTokens: 65536,
            contextWindow: 1_048_576,
            supportsImages: true,
            supportsPromptCache: true,
            thinking: ThinkingConfig.create({ supported: true, mode: "budget", maxBudget: 24576 }),
        },
    },
    "gpt-4": {
        id: "gpt-4",
        name: "gpt-4",
        description: DESC,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
    },
    "gpt-4o": {
        id: "gpt-4o",
        name: "gpt-4o",
        description: DESC,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
    },
    "gpt-4o-mini": {
        id: "gpt-4o-mini",
        name: "gpt-4o-mini",
        description: DESC,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
    },
    "gpt-4.1": {
        id: "gpt-4.1",
        name: "gpt-4.1",
        description: DESC,
        capabilities: {
            maxTokens: 32_768,
            contextWindow: 1_047_576,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "gpt-4.1-nano": {
        id: "gpt-4.1-nano",
        name: "gpt-4.1-nano",
        description: DESC,
        capabilities: {
            maxTokens: 32_768,
            contextWindow: 1_047_576,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "gpt-5": {
        id: "gpt-5",
        name: "gpt-5",
        description: DESC,
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 272_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "gpt-5-nano": {
        id: "gpt-5-nano",
        name: "gpt-5-nano",
        description: DESC,
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 272_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "gpt-5-mini": {
        id: "gpt-5-mini",
        name: "gpt-5-mini",
        description: DESC,
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 272_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "gpt-5.2": {
        id: "gpt-5.2",
        name: "gpt-5.2",
        description: DESC,
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 400_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "gpt-5.4": {
        id: "gpt-5.4",
        name: "gpt-5.4",
        description: DESC,
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 1_050_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "gpt-5.4-nano": {
        id: "gpt-5.4-nano",
        name: "gpt-5.4-nano",
        description: DESC,
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 400_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    o1: {
        id: "o1",
        name: "o1",
        description: DESC,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
    },
    o3: {
        id: "o3",
        name: "o3",
        description: DESC,
        capabilities: {
            maxTokens: 100_000,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    "o3-mini": {
        id: "o3-mini",
        name: "o3-mini",
        description: DESC,
        capabilities: {
            maxTokens: 4096,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
    },
    "o4-mini": {
        id: "o4-mini",
        name: "o4-mini",
        description: DESC,
        capabilities: {
            maxTokens: 100_000,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: true,
        },
    },
    sonar: {
        id: "sonar",
        name: "sonar",
        description: DESC,
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
    },
    "sonar-pro": {
        id: "sonar-pro",
        name: "sonar-pro",
        description: DESC,
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
    },
}

/** Default model ID for SAP AI Core provider */
export const sapAiCoreDefaultModelId = "anthropic--claude-3.5-sonnet"
