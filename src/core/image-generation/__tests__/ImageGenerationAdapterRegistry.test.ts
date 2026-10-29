import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it, vi } from "vitest"
import type { ImageGenerationAdapter } from "../contracts"
import { ImageGenerationError } from "../contracts"
import { ImageGenerationAdapterRegistry } from "../ImageGenerationAdapterRegistry"

const adapter: ImageGenerationAdapter = {
    async *generate() {},
}

function profile() {
    return ApiProfile.create({
        id: "profile-1",
        name: "OpenAI Images",
        provider: "openai",
        modelId: "gpt-chat",
        imageModelId: "gpt-image-2",
        usedFor: ["image"],
        enabled: true,
    })
}

describe("ImageGenerationAdapterRegistry", () => {
    it("creates an adapter from the exact provider registration", () => {
        const registry = new ImageGenerationAdapterRegistry()
        const factory = vi.fn(() => adapter)
        registry.register("openai", factory)

        expect(registry.has("openai")).toBe(true)
        expect(registry.has("openai-codex")).toBe(false)
        expect(registry.create("openai", { profile: profile(), modelId: "gpt-image-2" })).toBe(adapter)
        expect(factory).toHaveBeenCalledWith(expect.objectContaining({ modelId: "gpt-image-2" }))
    })

    it("rejects duplicate registrations and unknown providers with stable error codes", () => {
        const registry = new ImageGenerationAdapterRegistry()
        registry.register("openai", () => adapter)

        let duplicateError: unknown
        try {
            registry.register("openai", () => adapter)
        } catch (error) {
            duplicateError = error
        }
        expect(duplicateError).toBeInstanceOf(ImageGenerationError)
        expect((duplicateError as ImageGenerationError).code).toBe("adapter_already_registered")

        let missingError: unknown
        try {
            registry.create("gemini", { profile: profile(), modelId: "gemini-image" })
        } catch (error) {
            missingError = error
        }
        expect(missingError).toBeInstanceOf(ImageGenerationError)
        expect((missingError as ImageGenerationError).code).toBe("adapter_not_found")
    })
})
