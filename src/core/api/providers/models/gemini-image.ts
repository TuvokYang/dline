import type { ImageModelInfo } from "@shared/proto/dline/models"

const IMAGE_CAPABILITIES = {
    supportsGeneration: true,
    supportsEditing: true,
    supportsMask: false,
    supportsReferenceImages: true,
    supportsTransparentBackground: false,
    maxImages: 4,
} as const

export const geminiImageModels: Record<string, ImageModelInfo> = {
    "gemini-3.1-flash-image": {
        id: "gemini-3.1-flash-image",
        name: "Nano Banana 2",
        description: "Default Gemini image generation and editing model.",
        capabilities: IMAGE_CAPABILITIES,
        // Conservative 4K public API output price observed on 2026-09-02.
        pricing: { pricePerImage: 0.151, currency: "USD" },
        userDefined: false,
    },
    "gemini-3.1-flash-lite-image": {
        id: "gemini-3.1-flash-lite-image",
        name: "Nano Banana 2 Lite",
        description: "Low-cost 1K Gemini image generation and editing model.",
        capabilities: IMAGE_CAPABILITIES,
        pricing: { pricePerImage: 0.0336, currency: "USD" },
        userDefined: false,
    },
    "gemini-3-pro-image": {
        id: "gemini-3-pro-image",
        name: "Nano Banana Pro",
        description: "High-quality Gemini image generation and editing model.",
        capabilities: IMAGE_CAPABILITIES,
        // Conservative 4K public API output price observed on 2026-09-02.
        pricing: { pricePerImage: 0.24, currency: "USD" },
        userDefined: false,
    },
    "gemini-2.5-flash-image": {
        id: "gemini-2.5-flash-image",
        name: "Nano Banana",
        description: "Legacy Gemini image generation and editing model.",
        capabilities: IMAGE_CAPABILITIES,
        pricing: { pricePerImage: 0.039, currency: "USD" },
        userDefined: false,
    },
}

export const geminiDefaultImageModelId = "gemini-3.1-flash-image"
