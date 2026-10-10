import type { ImageGenerationPolicyInput, ImageGenerationPreflight } from "./contracts"
import { ImageGenerationError } from "./contracts"

export interface ImageGenerationPolicyLimits {
    maxImagesPerRequest: number
    maxWidth: number
    maxHeight: number
    maxPixelsPerImage: number
    maxReferenceImages: number
}

export const DEFAULT_IMAGE_GENERATION_POLICY_LIMITS: ImageGenerationPolicyLimits = {
    maxImagesPerRequest: 4,
    maxWidth: 4096,
    maxHeight: 4096,
    maxPixelsPerImage: 16_777_216,
    maxReferenceImages: 4,
}

export class ImageGenerationPolicy {
    private readonly limits: ImageGenerationPolicyLimits

    constructor(limits: Partial<ImageGenerationPolicyLimits> = {}) {
        this.limits = { ...DEFAULT_IMAGE_GENERATION_POLICY_LIMITS, ...limits }
    }

    validate(input: ImageGenerationPolicyInput): ImageGenerationPreflight {
        const { request, capabilities, pricing, budget } = input
        if (!request.prompt.trim()) {
            this.reject("invalid_request", "Image generation prompt must not be empty.")
        }

        const providerMaxImages =
            capabilities.maxImages && capabilities.maxImages > 0 ? capabilities.maxImages : Number.POSITIVE_INFINITY
        const maxImages = Math.min(this.limits.maxImagesPerRequest, providerMaxImages)
        if (!Number.isSafeInteger(request.count) || request.count < 1 || request.count > maxImages) {
            this.reject("count_limit_exceeded", `Image count must be between 1 and ${maxImages}.`)
        }

        if (request.size) {
            const { width, height } = request.size
            const invalidDimensions =
                !Number.isSafeInteger(width) ||
                !Number.isSafeInteger(height) ||
                width < 1 ||
                height < 1 ||
                width > this.limits.maxWidth ||
                height > this.limits.maxHeight ||
                width * height > this.limits.maxPixelsPerImage
            if (invalidDimensions) {
                this.reject("size_limit_exceeded", "Requested image dimensions exceed the configured safety limits.")
            }
        }

        if (
            request.outputCompression !== undefined &&
            (!Number.isSafeInteger(request.outputCompression) || request.outputCompression < 0 || request.outputCompression > 100)
        ) {
            this.reject("invalid_request", "Image output compression must be an integer between 0 and 100.")
        }
        if (request.outputCompression !== undefined && request.outputFormat !== "jpeg" && request.outputFormat !== "webp") {
            this.reject("invalid_request", "Image output compression is only supported for JPEG and WebP.")
        }
        if (request.background === "transparent" && request.outputFormat === "jpeg") {
            this.reject("invalid_request", "Transparent image output requires PNG or WebP format.")
        }

        if (request.references.length > this.limits.maxReferenceImages) {
            this.reject("reference_limit_exceeded", "Too many image references were provided.")
        }
        if (request.operation === "generate" && capabilities.supportsGeneration !== true) {
            this.reject("unsupported_operation", "The selected image model does not support generation.")
        }
        if (request.operation === "edit" && capabilities.supportsEditing !== true) {
            this.reject("unsupported_operation", "The selected image model does not support editing.")
        }
        if (
            request.references.some((reference) => reference.role === "reference") &&
            capabilities.supportsReferenceImages !== true
        ) {
            this.reject("unsupported_reference_images", "The selected image model does not support reference images.")
        }
        if (request.references.some((reference) => reference.role === "mask") && capabilities.supportsMask !== true) {
            this.reject("unsupported_mask", "The selected image model does not support masks.")
        }
        if (request.background === "transparent" && capabilities.supportsTransparentBackground !== true) {
            this.reject("unsupported_transparent_background", "The selected image model does not support transparent output.")
        }

        const pricePerImage = pricing?.pricePerImage
        const hasUsablePricing = pricePerImage !== undefined && Number.isFinite(pricePerImage) && pricePerImage >= 0
        if (budget && !hasUsablePricing) {
            this.reject("pricing_unavailable", "A task image budget is configured, but model pricing is unavailable.")
        }

        const estimatedCostUsd = hasUsablePricing ? pricePerImage * request.count : undefined
        if (budget && estimatedCostUsd !== undefined) {
            if (
                !Number.isFinite(budget.limitUsd) ||
                !Number.isFinite(budget.spentUsd) ||
                budget.limitUsd < 0 ||
                budget.spentUsd < 0
            ) {
                this.reject("invalid_request", "Image generation budget values must be finite non-negative numbers.")
            }
            if (budget.spentUsd + estimatedCostUsd > budget.limitUsd) {
                this.reject("budget_exceeded", "The image generation request would exceed the task budget.")
            }
        }

        return estimatedCostUsd === undefined
            ? {}
            : {
                  estimatedCostUsd,
                  ...(pricing?.currency ? { currency: pricing.currency } : {}),
              }
    }

    private reject(code: ImageGenerationError["code"], message: string): never {
        throw new ImageGenerationError({ code, message, retryable: false })
    }
}
