import type { ImageGenerationCapabilities, ImagePricing } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import type { ImageGenerationPolicyInput, ImageGenerationRequest } from "../contracts"
import { ImageGenerationError } from "../contracts"
import { ImageGenerationPolicy } from "../ImageGenerationPolicy"

function request(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
    return {
        requestId: "request-1",
        profileId: "profile-1",
        providerId: "openai",
        modelId: "gpt-image-2",
        operation: "generate",
        prompt: "A production-ready image",
        count: 1,
        references: [],
        ...overrides,
    }
}

function capabilities(overrides: Partial<ImageGenerationCapabilities> = {}): ImageGenerationCapabilities {
    return {
        supportsGeneration: true,
        supportsEditing: true,
        supportsMask: true,
        supportsReferenceImages: true,
        supportsTransparentBackground: true,
        maxImages: 4,
        ...overrides,
    }
}

function validate(overrides: Partial<ImageGenerationPolicyInput> = {}) {
    return new ImageGenerationPolicy().validate({
        request: request(),
        capabilities: capabilities(),
        ...overrides,
    })
}

function expectPolicyError(run: () => unknown, code: ImageGenerationError["code"]): void {
    try {
        run()
        throw new Error("Expected image generation policy to reject the request.")
    } catch (error) {
        expect(error).toBeInstanceOf(ImageGenerationError)
        expect((error as ImageGenerationError).code).toBe(code)
    }
}

describe("ImageGenerationPolicy", () => {
    it("returns an estimated per-image cost when the request fits capabilities and budget", () => {
        const pricing: ImagePricing = { pricePerImage: 0.04, currency: "USD" }
        const result = validate({
            request: request({ count: 2, size: { width: 1024, height: 1024 } }),
            pricing,
            budget: { limitUsd: 0.2, spentUsd: 0.1 },
        })

        expect(result).toEqual({ estimatedCostUsd: 0.08, currency: "USD" })
    })

    it("rejects count above the lower provider and Dline limit", () => {
        expectPolicyError(
            () => validate({ request: request({ count: 3 }), capabilities: capabilities({ maxImages: 2 }) }),
            "count_limit_exceeded",
        )
    })

    it("rejects oversized dimensions before the adapter is called", () => {
        expectPolicyError(() => validate({ request: request({ size: { width: 8192, height: 1024 } }) }), "size_limit_exceeded")
    })

    it("rejects edit, mask, reference, and transparent requests that the model cannot satisfy", () => {
        expectPolicyError(
            () =>
                validate({
                    request: request({ operation: "edit", references: [{ artifactId: "source", role: "reference" }] }),
                    capabilities: capabilities({ supportsEditing: false }),
                }),
            "unsupported_operation",
        )
        expectPolicyError(
            () =>
                validate({
                    request: request({ references: [{ artifactId: "source", role: "reference" }] }),
                    capabilities: capabilities({ supportsReferenceImages: false }),
                }),
            "unsupported_reference_images",
        )
        expectPolicyError(
            () =>
                validate({
                    request: request({ references: [{ artifactId: "mask", role: "mask" }] }),
                    capabilities: capabilities({ supportsMask: false }),
                }),
            "unsupported_mask",
        )
        expectPolicyError(
            () =>
                validate({
                    request: request({ background: "transparent" }),
                    capabilities: capabilities({ supportsTransparentBackground: false }),
                }),
            "unsupported_transparent_background",
        )
    })

    it("fails closed when a configured budget cannot be estimated or would be exceeded", () => {
        expectPolicyError(() => validate({ budget: { limitUsd: 1, spentUsd: 0 } }), "pricing_unavailable")
        expectPolicyError(
            () =>
                validate({
                    request: request({ count: 2 }),
                    pricing: { pricePerImage: 0.1, currency: "USD" },
                    budget: { limitUsd: 0.25, spentUsd: 0.1 },
                }),
            "budget_exceeded",
        )
    })
})
