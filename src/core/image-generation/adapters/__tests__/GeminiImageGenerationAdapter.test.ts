import type { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it, vi } from "vitest"
import type { ImageGenerationEvent, ImageGenerationRequest } from "../../contracts"
import {
    type GeminiGenerateContentParams,
    type GeminiImageClient,
    GeminiImageGenerationAdapter,
} from "../GeminiImageGenerationAdapter"

const IMAGE_BASE64 = "iVBORw0KGgo="

function profile(): ApiProfile {
    return {
        id: "gemini-image-profile",
        name: "Gemini Images",
        provider: "gemini",
        apiKey: "test-key",
        baseUrl: "https://generativelanguage.googleapis.com",
        imageModelId: "gemini-3.1-flash-image",
        enabled: true,
        usedFor: ["image"],
    } as ApiProfile
}

function request(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
    return {
        requestId: "request-1",
        profileId: "gemini-image-profile",
        providerId: "gemini",
        modelId: "gemini-3.1-flash-image",
        operation: "generate",
        prompt: "A blue owl",
        count: 2,
        aspectRatio: "16:9",
        outputFormat: "png",
        references: [],
        ...overrides,
    }
}

async function collect(events: AsyncIterable<ImageGenerationEvent>): Promise<ImageGenerationEvent[]> {
    const collected: ImageGenerationEvent[] = []
    for await (const event of events) collected.push(event)
    return collected
}

function client(generateContent: (params: GeminiGenerateContentParams) => Promise<unknown>): GeminiImageClient {
    return { models: { generateContent } } as unknown as GeminiImageClient
}

describe("GeminiImageGenerationAdapter", () => {
    it("requests text and image modalities and normalizes inline image parts", async () => {
        const generateContent = vi.fn(async (_params: GeminiGenerateContentParams) => ({
            candidates: [
                {
                    content: {
                        parts: [
                            { text: "A revised blue owl" },
                            { inlineData: { data: IMAGE_BASE64, mimeType: "image/png" } },
                            { inlineData: { data: IMAGE_BASE64, mimeType: "image/png" } },
                        ],
                    },
                },
            ],
        }))
        const adapter = new GeminiImageGenerationAdapter({
            profile: profile(),
            modelId: "gemini-3.1-flash-image",
            client: client(generateContent),
        })

        const events = await collect(adapter.generate(request(), { signal: new AbortController().signal }))

        expect(generateContent).toHaveBeenCalledWith(
            expect.objectContaining({
                model: "gemini-3.1-flash-image",
                contents: "A blue owl",
                config: expect.objectContaining({
                    abortSignal: expect.any(AbortSignal),
                    responseModalities: ["TEXT", "IMAGE"],
                    candidateCount: 2,
                    imageConfig: { aspectRatio: "16:9" },
                }),
            }),
        )
        const firstCall = generateContent.mock.calls.at(0)
        expect(firstCall?.[0].config).not.toHaveProperty("responseFormat")
        expect(events.map((event) => event.type)).toEqual(["queued", "started", "completed"])
        expect(events.at(-1)).toMatchObject({
            type: "completed",
            outputs: [
                {
                    id: "gemini-image-0",
                    source: { kind: "base64", data: IMAGE_BASE64, mimeType: "image/png" },
                    revisedPrompt: "A revised blue owl",
                },
                {
                    id: "gemini-image-1",
                    source: { kind: "base64", data: IMAGE_BASE64, mimeType: "image/png" },
                    revisedPrompt: "A revised blue owl",
                },
            ],
            usage: { imageCount: 2 },
        })
    })

    it("adds reference images as inlineData parts for edit requests", async () => {
        const generateContent = vi.fn(async (_params: GeminiGenerateContentParams) => ({
            candidates: [{ content: { parts: [{ inlineData: { data: IMAGE_BASE64, mimeType: "image/png" } }] } }],
        }))
        const resolveReference = vi.fn(async (_artifactId: string) => ({
            bytes: new Uint8Array([1, 2, 3]),
            mimeType: "image/png",
        }))
        const adapter = new GeminiImageGenerationAdapter({
            profile: profile(),
            modelId: "gemini-3.1-flash-image",
            client: client(generateContent),
            resolveReference,
        })

        await collect(
            adapter.generate(
                request({
                    operation: "edit",
                    references: [{ artifactId: "image:sha256:reference", role: "reference" }],
                }),
                { signal: new AbortController().signal },
            ),
        )

        const call = generateContent.mock.calls.at(0)
        expect(call).toBeDefined()
        if (!call) throw new Error("Gemini image request was not sent")
        const params = call[0] as { contents: Array<{ text?: string; inlineData?: { data: string; mimeType: string } }> }
        expect(params.contents).toEqual([{ text: "A blue owl" }, { inlineData: { data: "AQID", mimeType: "image/png" } }])
        expect(resolveReference).toHaveBeenCalledWith("image:sha256:reference", expect.any(AbortSignal))
    })

    it("maps Gemini rate limits to a retryable image error event", async () => {
        const generateContent = vi.fn(async (_params: GeminiGenerateContentParams) => {
            throw Object.assign(new Error("RESOURCE_EXHAUSTED"), { status: 429, code: "RESOURCE_EXHAUSTED" })
        })
        const adapter = new GeminiImageGenerationAdapter({
            profile: profile(),
            modelId: "gemini-3.1-flash-image",
            client: client(generateContent),
        })

        const events = await collect(adapter.generate(request(), { signal: new AbortController().signal }))

        expect(events.at(-1)).toMatchObject({
            type: "failed",
            error: { code: "rate_limited", retryable: true, providerCode: "RESOURCE_EXHAUSTED" },
        })
    })
})
