/**
 * AskSage provider model definitions.
 * Extracted from api.ts askSageModels (lines 3224-3348).
 */
import type { ModelInfo } from "@shared/api"

export const askSageModels: Record<string, ModelInfo> = {
    "gpt-4o": {
        id: "gpt-4o",
        name: "gpt-4o",
        capabilities: {
            maxTokens: 4096,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "gpt-4o-gov": {
        id: "gpt-4o-gov",
        name: "gpt-4o-gov",
        capabilities: {
            maxTokens: 4096,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "gpt-4.1": {
        id: "gpt-4.1",
        name: "gpt-4.1",
        capabilities: {
            maxTokens: 32_768,
            contextWindow: 1_047_576,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "claude-35-sonnet": {
        id: "claude-35-sonnet",
        name: "claude-35-sonnet",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "aws-bedrock-claude-35-sonnet-gov": {
        id: "aws-bedrock-claude-35-sonnet-gov",
        name: "aws-bedrock-claude-35-sonnet-gov",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "claude-37-sonnet": {
        id: "claude-37-sonnet",
        name: "claude-37-sonnet",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "claude-4.6-sonnet": {
        id: "claude-4.6-sonnet",
        name: "claude-4.6-sonnet",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "claude-4-sonnet": {
        id: "claude-4-sonnet",
        name: "claude-4-sonnet",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "claude-4-opus": {
        id: "claude-4-opus",
        name: "claude-4-opus",
        capabilities: {
            maxTokens: 8192,
            contextWindow: 200_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "google-gemini-2.5-pro": {
        id: "google-gemini-2.5-pro",
        name: "google-gemini-2.5-pro",
        capabilities: {
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
    "google-claude-45-sonnet": {
        id: "google-claude-45-sonnet",
        name: "google-claude-45-sonnet",
        capabilities: {
            maxTokens: 64000,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "google-claude-4-opus": {
        id: "google-claude-4-opus",
        name: "google-claude-4-opus",
        capabilities: {
            maxTokens: 32000,
            contextWindow: 200_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "gpt-5": {
        id: "gpt-5",
        name: "gpt-5",
        capabilities: {
            maxTokens: 65536,
            contextWindow: 2_097_152,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "gpt-5-mini": {
        id: "gpt-5-mini",
        name: "gpt-5-mini",
        capabilities: {
            maxTokens: 32768,
            contextWindow: 1_048_576,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "gpt-5-nano": {
        id: "gpt-5-nano",
        name: "gpt-5-nano",
        capabilities: {
            maxTokens: 16384,
            contextWindow: 262_144,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
}

/** Default model ID for Ask Sage provider */
export const askSageDefaultModelId = "claude-4-sonnet"

/** Default API URL for Ask Sage provider */
export const askSageDefaultURL = "https://api.asksage.ai/server"
