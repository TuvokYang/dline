/**
 * Mistral provider model definitions.
 * Extracted from api.ts mistralModels (lines 3060-3223).
 */
import type { ModelInfo } from "@shared/api"

export const mistralModels: Record<string, ModelInfo> = {
    "devstral-2512": {
        id: "devstral-2512",
        name: "devstral-2512",
        capabilities: {
            maxTokens: 256_000,
            contextWindow: 256_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "labs-devstral-small-2512": {
        id: "labs-devstral-small-2512",
        name: "labs-devstral-small-2512",
        capabilities: {
            maxTokens: 256_000,
            contextWindow: 256_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0,
            outputPrice: 0,
        },
    },
    "mistral-large-2512": {
        id: "mistral-large-2512",
        name: "mistral-large-2512",
        capabilities: {
            maxTokens: 256_000,
            contextWindow: 256_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.5,
            outputPrice: 1.5,
        },
    },
    "ministral-14b-2512": {
        id: "ministral-14b-2512",
        name: "ministral-14b-2512",
        capabilities: {
            maxTokens: 256_000,
            contextWindow: 256_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.2,
            outputPrice: 0.2,
        },
    },
    "mistral-large-2411": {
        id: "mistral-large-2411",
        name: "mistral-large-2411",
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
    "pixtral-large-2411": {
        id: "pixtral-large-2411",
        name: "pixtral-large-2411",
        capabilities: {
            maxTokens: 131_000,
            contextWindow: 131_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 2.0,
            outputPrice: 6.0,
        },
    },
    "ministral-3b-2410": {
        id: "ministral-3b-2410",
        name: "ministral-3b-2410",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.04,
            outputPrice: 0.04,
        },
    },
    "ministral-8b-2410": {
        id: "ministral-8b-2410",
        name: "ministral-8b-2410",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.1,
            outputPrice: 0.1,
        },
    },
    "mistral-small-latest": {
        id: "mistral-small-latest",
        name: "mistral-small-latest",
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
    "mistral-medium-latest": {
        id: "mistral-medium-latest",
        name: "mistral-medium-latest",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 128_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.4,
            outputPrice: 2.0,
        },
    },
    "mistral-small-2501": {
        id: "mistral-small-2501",
        name: "mistral-small-2501",
        capabilities: {
            maxTokens: 32_000,
            contextWindow: 32_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.1,
            outputPrice: 0.3,
        },
    },
    "pixtral-12b-2409": {
        id: "pixtral-12b-2409",
        name: "pixtral-12b-2409",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 128_000,
            supportsImages: true,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.15,
            outputPrice: 0.15,
        },
    },
    "open-mistral-nemo-2407": {
        id: "open-mistral-nemo-2407",
        name: "open-mistral-nemo-2407",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 128_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.15,
            outputPrice: 0.15,
        },
    },
    "open-codestral-mamba": {
        id: "open-codestral-mamba",
        name: "open-codestral-mamba",
        capabilities: {
            maxTokens: 256_000,
            contextWindow: 256_000,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.15,
            outputPrice: 0.15,
        },
    },
    "codestral-2501": {
        id: "codestral-2501",
        name: "codestral-2501",
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
    "devstral-small-2505": {
        id: "devstral-small-2505",
        name: "devstral-small-2505",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.1,
            outputPrice: 0.3,
        },
    },
    "devstral-medium-latest": {
        id: "devstral-medium-latest",
        name: "devstral-medium-latest",
        capabilities: {
            maxTokens: 128_000,
            contextWindow: 131_072,
            supportsImages: false,
            supportsPromptCache: false,
        },
        pricing: {
            inputPrice: 0.4,
            outputPrice: 2.0,
        },
    },
}

/** Default model ID for Mistral provider */
export const mistralDefaultModelId = "devstral-2512"
