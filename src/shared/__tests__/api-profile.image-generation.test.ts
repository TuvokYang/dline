import { ApiProfile, ImageGenerationProfileSettings } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"

describe("ApiProfile image generation settings", () => {
    it("round-trips independent image budget, timeout, and concurrency settings", () => {
        const profile = ApiProfile.create({
            id: "profile-1",
            name: "OpenAI Images",
            provider: "openai",
            modelId: "gpt-5",
            imageModelId: "gpt-image-2",
            usedFor: ["act"],
            enabled: true,
            imageGeneration: ImageGenerationProfileSettings.create({
                taskBudgetUsd: 1.5,
                requestTimeoutMs: 90_000,
                maxConcurrentRequests: 2,
            }),
        })

        const jsonRoundTrip = ApiProfile.fromJSON(ApiProfile.toJSON(profile))
        const binaryRoundTrip = ApiProfile.decode(ApiProfile.encode(profile).finish())

        expect(jsonRoundTrip.imageGeneration).toEqual(profile.imageGeneration)
        expect(binaryRoundTrip.imageGeneration).toEqual(profile.imageGeneration)
        expect(binaryRoundTrip.modelId).toBe("gpt-5")
        expect(binaryRoundTrip.imageModelId).toBe("gpt-image-2")
    })

    it("keeps legacy profiles valid when image generation settings are omitted", () => {
        const profile = ApiProfile.fromJSON({ id: "legacy", modelId: "chat-model", usedFor: ["act"] })

        expect(profile.imageGeneration).toBeUndefined()
    })
})
