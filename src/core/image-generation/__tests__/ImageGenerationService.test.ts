import type { ImageArtifact } from "@core/artifacts/TaskArtifactStore"
import { type ApiProfile, ImageGenerationSource } from "@shared/proto/dline/profile"
import { describe, expect, it, vi } from "vitest"
import type {
    ImageGenerationEvent,
    ImageGenerationExecutionContext,
    ImageGenerationRequest,
    ImageProviderOutput,
} from "../contracts"
import { ImageGenerationAdapterRegistry } from "../ImageGenerationAdapterRegistry"
import { ImageGenerationPolicy } from "../ImageGenerationPolicy"
import { ImageGenerationService } from "../ImageGenerationService"
import type { ResolvedImageProfile } from "../ImageProfileResolver"
import { FakeImageGenerationAdapter } from "../testing/FakeImageGenerationAdapter"

const output: ImageProviderOutput = {
    id: "provider-output-1",
    source: { kind: "base64", data: "aW1hZ2U=", mimeType: "image/png" },
    width: 1,
    height: 1,
    revisedPrompt: "A revised prompt",
}

const artifact: ImageArtifact = {
    schemaVersion: 1,
    id: `image:sha256:${"a".repeat(64)}`,
    kind: "image",
    sha256: "a".repeat(64),
    mimeType: "image/png",
    format: "png",
    byteLength: 5,
    width: 1,
    height: 1,
    relativePath: `images/${"a".repeat(64)}.png`,
    createdAtMs: 10,
}

const resolvedProfile: ResolvedImageProfile = {
    source: ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION,
    adapterId: "openai",
    profile: {
        id: "profile-1",
        name: "OpenAI Images",
        provider: "openai",
        imageModelId: "gpt-image-2",
        usedFor: ["image"],
        enabled: true,
    } as ApiProfile,
    model: {
        id: "gpt-image-2",
        capabilities: { supportsGeneration: true, supportsEditing: true, supportsReferenceImages: true, maxImages: 4 },
        pricing: { pricePerImage: 0.04, currency: "USD" },
    },
}

function budgetedProfile(): ResolvedImageProfile {
    return {
        ...resolvedProfile,
        profile: {
            ...resolvedProfile.profile,
            imageGeneration: { taskBudgetUsd: 1 },
        },
    }
}

function request(): ImageGenerationRequest {
    return {
        requestId: "request-1",
        profileId: "profile-1",
        providerId: "openai",
        modelId: "gpt-image-2",
        operation: "generate",
        prompt: "A safe prompt",
        count: 1,
        references: [],
    }
}

describe("ImageGenerationService", () => {
    it("preflights, executes the adapter, and persists completed outputs as safe artifacts", async () => {
        const registry = new ImageGenerationAdapterRegistry()
        registry.register("openai", () => new FakeImageGenerationAdapter({ outputs: [output], now: () => 20 }))
        const persistProviderOutputs = vi.fn(async () => [artifact])
        const service = new ImageGenerationService({
            profileResolver: { resolve: () => resolvedProfile, hasAvailableProfile: () => true },
            adapterRegistry: registry,
            policy: new ImageGenerationPolicy(),
            artifactResolver: { persistProviderOutputs },
        })

        const result = await service.generate(request(), { signal: new AbortController().signal })

        expect(result.artifacts).toEqual([artifact])
        expect(result.usage).toMatchObject({ imageCount: 1, estimatedCostUsd: 0.04, currency: "USD" })
        expect(persistProviderOutputs).toHaveBeenCalledWith(
            [output],
            { providerId: "openai", modelId: "gpt-image-2", requestId: "request-1" },
            expect.any(AbortSignal),
        )
        expect(JSON.stringify(result)).not.toContain("aW1hZ2U=")
    })

    it("records deduplicated parent artifacts for local edit outputs", async () => {
        const registry = new ImageGenerationAdapterRegistry()
        registry.register("openai", () => new FakeImageGenerationAdapter({ outputs: [output], now: () => 20 }))
        const persistProviderOutputs = vi.fn(async () => [artifact])
        const service = new ImageGenerationService({
            profileResolver: { resolve: () => resolvedProfile, hasAvailableProfile: () => true },
            adapterRegistry: registry,
            policy: new ImageGenerationPolicy(),
            artifactResolver: { persistProviderOutputs },
        })
        const parentArtifactId = `image:sha256:${"b".repeat(64)}`

        await service.generate(
            {
                ...request(),
                operation: "edit",
                references: [
                    { artifactId: parentArtifactId, role: "reference" },
                    { artifactId: parentArtifactId, role: "reference" },
                ],
            },
            { signal: new AbortController().signal },
        )

        expect(persistProviderOutputs).toHaveBeenCalledWith(
            [output],
            {
                providerId: "openai",
                modelId: "gpt-image-2",
                requestId: "request-1",
                parentArtifactIds: [parentArtifactId],
            },
            expect.any(AbortSignal),
        )
    })

    it("reserves before the provider call and settles before committing artifacts", async () => {
        const registry = new ImageGenerationAdapterRegistry()
        const providerGenerate = vi.fn(async function* (
            imageRequest: ImageGenerationRequest,
        ): AsyncGenerator<ImageGenerationEvent> {
            yield {
                type: "completed",
                requestId: imageRequest.requestId,
                timestampMs: 20,
                outputs: [output],
                usage: { imageCount: 1 },
            }
        })
        registry.register("openai", () => ({ generate: providerGenerate }))
        const budgetLedger = {
            reserve: vi.fn(async () => undefined),
            settle: vi.fn(async () => undefined),
            release: vi.fn(async () => undefined),
        }
        const persistProviderOutputs = vi.fn(async () => [artifact])
        const service = new ImageGenerationService({
            profileResolver: { resolve: () => budgetedProfile(), hasAvailableProfile: () => true },
            adapterRegistry: registry,
            policy: new ImageGenerationPolicy(),
            artifactResolver: { persistProviderOutputs },
            budgetLedger,
        })

        await service.generate(request(), { signal: new AbortController().signal })

        expect(budgetLedger.reserve).toHaveBeenCalledWith({
            requestId: "request-1",
            providerId: "openai",
            modelId: "gpt-image-2",
            estimatedCostUsd: 0.04,
            limitUsd: 1,
        })
        expect(budgetLedger.settle).toHaveBeenCalledWith("request-1")
        expect(budgetLedger.release).not.toHaveBeenCalled()
        expect(budgetLedger.reserve.mock.invocationCallOrder[0]).toBeLessThan(providerGenerate.mock.invocationCallOrder[0])
        expect(budgetLedger.settle.mock.invocationCallOrder[0]).toBeLessThan(persistProviderOutputs.mock.invocationCallOrder[0])
    })

    it("releases a reservation when the provider fails before completion", async () => {
        const registry = new ImageGenerationAdapterRegistry()
        registry.register(
            "openai",
            () =>
                new FakeImageGenerationAdapter({
                    outputs: [],
                    failure: { code: "provider_error", message: "failed", retryable: true },
                }),
        )
        const budgetLedger = {
            reserve: vi.fn(async () => undefined),
            settle: vi.fn(async () => undefined),
            release: vi.fn(async () => undefined),
        }
        const persistProviderOutputs = vi.fn()
        const service = new ImageGenerationService({
            profileResolver: { resolve: () => budgetedProfile(), hasAvailableProfile: () => true },
            adapterRegistry: registry,
            policy: new ImageGenerationPolicy(),
            artifactResolver: { persistProviderOutputs },
            budgetLedger,
        })

        await expect(service.generate(request(), { signal: new AbortController().signal })).rejects.toMatchObject({
            code: "provider_error",
        })
        expect(budgetLedger.reserve).toHaveBeenCalledOnce()
        expect(budgetLedger.release).toHaveBeenCalledWith("request-1")
        expect(budgetLedger.settle).not.toHaveBeenCalled()
        expect(persistProviderOutputs).not.toHaveBeenCalled()
    })

    it("releases a reservation and reports timeout when the provider observes the execution deadline", async () => {
        vi.useFakeTimers()
        try {
            const registry = new ImageGenerationAdapterRegistry()
            registry.register("openai", () => ({
                async *generate(imageRequest: ImageGenerationRequest, context: ImageGenerationExecutionContext) {
                    yield { type: "queued", requestId: imageRequest.requestId, timestampMs: 1 } as const
                    await new Promise<void>((resolve) =>
                        context.signal.addEventListener("abort", () => resolve(), { once: true }),
                    )
                    yield {
                        type: "cancelled",
                        requestId: imageRequest.requestId,
                        timestampMs: 2,
                        reason: "deadline",
                    } as const
                },
            }))
            const budgetLedger = {
                reserve: vi.fn(async () => undefined),
                settle: vi.fn(async () => undefined),
                release: vi.fn(async () => undefined),
            }
            const timeoutProfile = budgetedProfile()
            timeoutProfile.profile.imageGeneration = { taskBudgetUsd: 1, requestTimeoutMs: 25 }
            const service = new ImageGenerationService({
                profileResolver: { resolve: () => timeoutProfile, hasAvailableProfile: () => true },
                adapterRegistry: registry,
                policy: new ImageGenerationPolicy(),
                artifactResolver: { persistProviderOutputs: vi.fn() },
                budgetLedger,
            })

            const pending = service.generate(request(), { signal: new AbortController().signal })
            const rejection = expect(pending).rejects.toMatchObject({ code: "timeout" })
            await vi.advanceTimersByTimeAsync(25)
            await rejection
            expect(budgetLedger.release).toHaveBeenCalledWith("request-1")
            expect(budgetLedger.settle).not.toHaveBeenCalled()
        } finally {
            vi.useRealTimers()
        }
    })

    it("keeps a settled charge when artifact persistence fails after provider completion", async () => {
        const registry = new ImageGenerationAdapterRegistry()
        registry.register("openai", () => new FakeImageGenerationAdapter({ outputs: [output] }))
        const budgetLedger = {
            reserve: vi.fn(async () => undefined),
            settle: vi.fn(async () => undefined),
            release: vi.fn(async () => undefined),
        }
        const persistenceError = new Error("artifact commit failed")
        const service = new ImageGenerationService({
            profileResolver: { resolve: () => budgetedProfile(), hasAvailableProfile: () => true },
            adapterRegistry: registry,
            policy: new ImageGenerationPolicy(),
            artifactResolver: { persistProviderOutputs: vi.fn(async () => Promise.reject(persistenceError)) },
            budgetLedger,
        })

        await expect(service.generate(request(), { signal: new AbortController().signal })).rejects.toBe(persistenceError)
        expect(budgetLedger.settle).toHaveBeenCalledWith("request-1")
        expect(budgetLedger.release).not.toHaveBeenCalled()
    })

    it("projects preview events without exposing provider base64 or URL payloads", async () => {
        const registry = new ImageGenerationAdapterRegistry()
        registry.register(
            "openai",
            () => new FakeImageGenerationAdapter({ outputs: [output], previewOutputs: [output], now: () => 20 }),
        )
        const onProgress = vi.fn()
        const persistPreview = vi.fn(async (_requestId: string, sequence: number) => ({
            id: `image-preview:sha256:${String(sequence).repeat(64)}`,
            mimeType: "image/png" as const,
            width: 512,
            height: 288,
            sequence,
        }))
        const clearRequest = vi.fn(async () => undefined)
        const service = new ImageGenerationService({
            profileResolver: { resolve: () => resolvedProfile, hasAvailableProfile: () => true },
            adapterRegistry: registry,
            policy: new ImageGenerationPolicy(),
            artifactResolver: { persistProviderOutputs: vi.fn(async () => [artifact]) },
            previewStore: { persistPreview, clearRequest },
        })

        await service.generate(request(), { signal: new AbortController().signal, onProgress })

        expect(persistPreview).toHaveBeenCalledWith("request-1", 0, "aW1hZ2U=")
        expect(onProgress).toHaveBeenCalledWith({
            type: "preview",
            requestId: "request-1",
            timestampMs: 20,
            preview: expect.objectContaining({ sequence: 0, width: 512, height: 288 }),
        })
        expect(clearRequest).not.toHaveBeenCalled()
        expect(JSON.stringify(onProgress.mock.calls)).not.toContain(output.source.kind === "base64" ? output.source.data : "")
    })

    it("fails closed before resolving a profile when Feature Settings disables image generation", async () => {
        const registry = new ImageGenerationAdapterRegistry()
        const resolve = vi.fn(() => resolvedProfile)
        const service = new ImageGenerationService({
            profileResolver: { resolve, hasAvailableProfile: () => true },
            adapterRegistry: registry,
            policy: new ImageGenerationPolicy(),
            artifactResolver: { persistProviderOutputs: vi.fn() },
            isFeatureEnabled: () => false,
        })

        expect(service.hasAvailableProfile()).toBe(false)
        expect(() => service.resolveProfile()).toThrow(/disabled in Feature Settings/)
        await expect(service.generate(request(), { signal: new AbortController().signal })).rejects.toMatchObject({
            code: "invalid_request",
        })
        expect(resolve).not.toHaveBeenCalled()
    })

    it("rejects mismatched resolved identity before adapter execution", async () => {
        const registry = new ImageGenerationAdapterRegistry()
        const generate = vi.fn()
        registry.register("openai", () => ({ generate }))
        const service = new ImageGenerationService({
            profileResolver: { resolve: () => resolvedProfile, hasAvailableProfile: () => true },
            adapterRegistry: registry,
            policy: new ImageGenerationPolicy(),
            artifactResolver: { persistProviderOutputs: vi.fn() },
        })
        const mismatched = { ...request(), modelId: "unexpected-model" }

        await expect(service.generate(mismatched, { signal: new AbortController().signal })).rejects.toMatchObject({
            code: "invalid_request",
        })
        expect(generate).not.toHaveBeenCalled()
    })
})
