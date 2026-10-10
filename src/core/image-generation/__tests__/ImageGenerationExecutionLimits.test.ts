import type { ImageArtifact } from "@core/artifacts/TaskArtifactStore"
import { type ApiProfile, ImageGenerationSource } from "@shared/proto/dline/profile"
import { describe, expect, it, vi } from "vitest"
import type { ImageGenerationAdapter, ImageGenerationRequest } from "../contracts"
import { ImageGenerationAdapterRegistry } from "../ImageGenerationAdapterRegistry"
import { ImageGenerationPolicy } from "../ImageGenerationPolicy"
import { ImageGenerationService } from "../ImageGenerationService"
import type { ResolvedImageProfile } from "../ImageProfileResolver"

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

function request(requestId: string): ImageGenerationRequest {
    return {
        requestId,
        profileId: "profile-1",
        providerId: "openai",
        modelId: "gpt-image-2",
        operation: "generate",
        prompt: "A safe prompt",
        count: 1,
        references: [],
    }
}

function resolvedProfile(overrides: Partial<NonNullable<ApiProfile["imageGeneration"]>> = {}): ResolvedImageProfile {
    return {
        source: ImageGenerationSource.IMAGE_GENERATION_SOURCE_GPT_SUBSCRIPTION,
        adapterId: "openai",
        profile: {
            id: "profile-1",
            name: "OpenAI Images",
            provider: "openai",
            modelId: "gpt-chat",
            imageModelId: "gpt-image-2",
            usedFor: ["image"],
            enabled: true,
            imageGeneration: {
                taskBudgetUsd: 1,
                requestTimeoutMs: 120_000,
                maxConcurrentRequests: 1,
                ...overrides,
            },
        } as ApiProfile,
        model: {
            id: "gpt-image-2",
            capabilities: { supportsGeneration: true, maxImages: 4 },
            pricing: { pricePerImage: 0.04, currency: "USD" },
        },
    }
}

function service(adapter: ImageGenerationAdapter, profile = resolvedProfile()) {
    const registry = new ImageGenerationAdapterRegistry()
    registry.register("openai", () => adapter)
    const reserve = vi.fn(async () => undefined)
    const settle = vi.fn(async () => undefined)
    const release = vi.fn(async () => undefined)
    return {
        reserve,
        settle,
        release,
        service: new ImageGenerationService({
            profileResolver: { resolve: () => profile, hasAvailableProfile: () => true },
            adapterRegistry: registry,
            policy: new ImageGenerationPolicy(),
            artifactResolver: { persistProviderOutputs: vi.fn(async () => [artifact]) },
            budgetLedger: { reserve, settle, release },
        }),
    }
}

describe("ImageGenerationService execution limits", () => {
    it("reserves the configured task budget before invoking the paid adapter", async () => {
        const generate = vi.fn(async function* (imageRequest: ImageGenerationRequest) {
            yield {
                type: "completed" as const,
                requestId: imageRequest.requestId,
                timestampMs: 1,
                outputs: [
                    { id: "output-1", source: { kind: "bytes" as const, bytes: new Uint8Array([1]), mimeType: "image/png" } },
                ],
                usage: { imageCount: 1 },
            }
        })
        const runtime = service({ generate })

        await runtime.service.generate(request("request-1"), { signal: new AbortController().signal })

        expect(runtime.reserve).toHaveBeenCalledWith({
            requestId: "request-1",
            providerId: "openai",
            modelId: "gpt-image-2",
            estimatedCostUsd: 0.04,
            limitUsd: 1,
        })
        expect(runtime.reserve.mock.invocationCallOrder[0]).toBeLessThan(generate.mock.invocationCallOrder[0])
    })

    it("shares the configured concurrency limit with services rebound to another Profile resolver", async () => {
        let releaseFirst: (() => void) | undefined
        const firstStarted = new Promise<void>((resolve) => {
            releaseFirst = resolve
        })
        let notifyEntered: (() => void) | undefined
        const entered = new Promise<void>((resolve) => {
            notifyEntered = resolve
        })
        const adapter: ImageGenerationAdapter = {
            async *generate(imageRequest) {
                notifyEntered?.()
                await firstStarted
                yield {
                    type: "completed",
                    requestId: imageRequest.requestId,
                    timestampMs: 1,
                    outputs: [{ id: "output-1", source: { kind: "bytes", bytes: new Uint8Array([1]), mimeType: "image/png" } }],
                    usage: { imageCount: 1 },
                }
            },
        }
        const runtime = service(adapter, resolvedProfile({ maxConcurrentRequests: 1 }))
        const first = runtime.service.generate(request("request-1"), { signal: new AbortController().signal })
        await entered
        const reboundService = runtime.service.withProfileResolver({
            resolve: () => resolvedProfile(),
            hasAvailableProfile: () => true,
        })
        const second = reboundService.generate(request("request-2"), { signal: new AbortController().signal })
        const secondExpectation = expect(second).rejects.toMatchObject({ code: "concurrency_limit_exceeded" })
        releaseFirst?.()
        await first

        await secondExpectation
    })

    it("uses a three-minute default timeout", async () => {
        vi.useFakeTimers()
        const outerController = new AbortController()
        try {
            let adapterSignal: AbortSignal | undefined
            const adapter: ImageGenerationAdapter = {
                async *generate(imageRequest, context) {
                    adapterSignal = context.signal
                    await new Promise<void>((resolve) =>
                        context.signal.addEventListener("abort", () => resolve(), { once: true }),
                    )
                    yield {
                        type: "cancelled",
                        requestId: imageRequest.requestId,
                        timestampMs: 1,
                        reason: "aborted",
                    }
                },
            }
            const runtime = service(adapter, resolvedProfile({ requestTimeoutMs: undefined }))
            const generation = runtime.service.generate(request("request-default-timeout"), { signal: outerController.signal })
            const expectation = expect(generation).rejects.toMatchObject({ code: "timeout", retryable: true })

            await vi.advanceTimersByTimeAsync(179_999)
            expect(adapterSignal?.aborted).toBe(false)
            await vi.advanceTimersByTimeAsync(1)

            await expectation
        } finally {
            outerController.abort("test_cleanup")
            vi.useRealTimers()
        }
    })

    it("aborts the adapter at the configured timeout and reports a timeout error", async () => {
        vi.useFakeTimers()
        const outerController = new AbortController()
        try {
            let adapterSignal: AbortSignal | undefined
            const adapter: ImageGenerationAdapter = {
                async *generate(imageRequest, context) {
                    adapterSignal = context.signal
                    await new Promise<void>((resolve) =>
                        context.signal.addEventListener("abort", () => resolve(), { once: true }),
                    )
                    yield {
                        type: "cancelled",
                        requestId: imageRequest.requestId,
                        timestampMs: 1,
                        reason: "aborted",
                    }
                },
            }
            const runtime = service(adapter, resolvedProfile({ requestTimeoutMs: 25 }))
            const generation = runtime.service.generate(request("request-1"), { signal: outerController.signal })
            const expectation = expect(generation).rejects.toMatchObject({ code: "timeout", retryable: true })
            await vi.advanceTimersByTimeAsync(25)
            if (!adapterSignal?.aborted) outerController.abort("test_cleanup")

            await expectation
        } finally {
            outerController.abort("test_cleanup")
            vi.useRealTimers()
        }
    })
})
