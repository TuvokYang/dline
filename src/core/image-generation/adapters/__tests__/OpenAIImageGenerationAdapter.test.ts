import type { ApiProfile } from "@shared/proto/dline/profile"
import type OpenAI from "openai"
import { describe, expect, it, vi } from "vitest"
import type { ImageGenerationEvent, ImageGenerationRequest } from "../../contracts"
import { OpenAIImageGenerationAdapter } from "../OpenAIImageGenerationAdapter"

const IMAGE_BASE64 = "iVBORw0KGgo="

function profile(): ApiProfile {
	return {
		id: "openai-image-profile",
		name: "OpenAI Images",
		provider: "openai",
		apiKey: "test-key",
		baseUrl: "https://api.openai.test/v1",
		imageModelId: "gpt-image-2",
		enabled: true,
		usedFor: ["image"],
	} as ApiProfile
}

function request(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
	return {
		requestId: "request-1",
		profileId: "openai-image-profile",
		providerId: "openai",
		modelId: "gpt-image-2",
		operation: "generate",
		prompt: "A blue owl",
		count: 2,
		size: { width: 1024, height: 1536 },
		quality: "high",
		background: "opaque",
		outputFormat: "webp",
		outputCompression: 80,
		references: [],
		...overrides,
	}
}

async function collect(events: AsyncIterable<ImageGenerationEvent>): Promise<ImageGenerationEvent[]> {
	const collected: ImageGenerationEvent[] = []
	for await (const event of events) collected.push(event)
	return collected
}

function client(images: { generate: ReturnType<typeof vi.fn>; edit: ReturnType<typeof vi.fn> }): OpenAI {
	return { images } as unknown as OpenAI
}

describe("OpenAIImageGenerationAdapter", () => {
	it("maps generation parameters and normalizes base64 outputs", async () => {
		const generate = vi.fn(async () => ({
			data: [{ b64_json: IMAGE_BASE64, revised_prompt: "A revised blue owl" }, { b64_json: IMAGE_BASE64 }],
			usage: { input_tokens: 12, output_tokens: 34, total_tokens: 46 },
		}))
		const edit = vi.fn()
		const adapter = new OpenAIImageGenerationAdapter({
			profile: profile(),
			modelId: "gpt-image-2",
			client: client({ generate, edit }),
		})

		const events = await collect(adapter.generate(request(), { signal: new AbortController().signal }))

		expect(generate).toHaveBeenCalledWith(
			{
				model: "gpt-image-2",
				prompt: "A blue owl",
				n: 2,
				size: "1024x1536",
				quality: "high",
				background: "opaque",
				output_format: "webp",
				output_compression: 80,
			},
			{ signal: expect.any(AbortSignal) },
		)
		expect(edit).not.toHaveBeenCalled()
		expect(events.map((event) => event.type)).toEqual(["queued", "started", "completed"])
		const completed = events[2]
		expect(completed).toMatchObject({
			type: "completed",
			outputs: [
				{
					id: "openai-image-0",
					source: { kind: "base64", data: IMAGE_BASE64, mimeType: "image/webp" },
					revisedPrompt: "A revised blue owl",
				},
				{ id: "openai-image-1", source: { kind: "base64", data: IMAGE_BASE64, mimeType: "image/webp" } },
			],
			usage: { imageCount: 2 },
		})
	})

	it("uses the 2K landscape default for a single GPT Image 2 PNG generation", async () => {
		const generate = vi.fn(async () => ({ data: [{ b64_json: IMAGE_BASE64 }] }))
		const adapter = new OpenAIImageGenerationAdapter({
			profile: profile(),
			modelId: "gpt-image-2",
			client: client({ generate, edit: vi.fn() }),
		})

		await collect(
			adapter.generate(
				request({
					count: 1,
					size: undefined,
					quality: undefined,
					background: undefined,
					outputFormat: "png",
					outputCompression: undefined,
				}),
				{ signal: new AbortController().signal },
			),
		)

		expect(generate).toHaveBeenCalledWith(
			{
				model: "gpt-image-2",
				prompt: "A blue owl",
				size: "2048x1152",
				quality: "auto",
				background: "auto",
			},
			{ signal: expect.any(AbortSignal) },
		)
	})

	it.each([
		{ width: 1920, height: 1080 },
		{ width: 640, height: 480 },
	])("rejects unsupported GPT Image 2 custom dimensions before calling OpenAI", async ({ width, height }) => {
		const generate = vi.fn(async () => ({ data: [{ b64_json: IMAGE_BASE64 }] }))
		const adapter = new OpenAIImageGenerationAdapter({
			profile: profile(),
			modelId: "gpt-image-2",
			client: client({ generate, edit: vi.fn() }),
		})

		const events = await collect(
			adapter.generate(request({ count: 1, size: { width, height } }), { signal: new AbortController().signal }),
		)

		expect(generate).not.toHaveBeenCalled()
		expect(events.at(-1)).toMatchObject({ type: "failed", error: { code: "size_limit_exceeded", retryable: false } })
	})

	it("resolves reference artifacts for edit requests and forwards the mask", async () => {
		const generate = vi.fn()
		const edit = vi.fn(async (_body: unknown, _options?: unknown) => ({ data: [{ b64_json: IMAGE_BASE64 }] }))
		const resolveReference = vi.fn(async (artifactId: string) => ({
			bytes: new Uint8Array([1, 2, 3]),
			mimeType: artifactId.endsWith("mask") ? "image/png" : "image/jpeg",
		}))
		const adapter = new OpenAIImageGenerationAdapter({
			profile: profile(),
			modelId: "gpt-image-2",
			client: client({ generate, edit }),
			resolveReference,
		})

		const events = await collect(
			adapter.generate(
				request({
					operation: "edit",
					references: [
						{ artifactId: "image:sha256:reference", role: "reference" },
						{ artifactId: "image:sha256:mask", role: "mask" },
					],
				}),
				{ signal: new AbortController().signal },
			),
		)

		expect(generate).not.toHaveBeenCalled()
		expect(resolveReference).toHaveBeenCalledTimes(2)
		expect(edit).toHaveBeenCalledOnce()
		const firstCall = edit.mock.calls.at(0)
		expect(firstCall).toBeDefined()
		if (!firstCall) throw new Error("OpenAI edit was not called")
		const editParams = firstCall[0] as { model: string; image: unknown[]; mask: unknown; prompt: string }
		expect(editParams.model).toBe("gpt-image-2")
		expect(editParams.prompt).toBe("A blue owl")
		expect(editParams.image).toHaveLength(1)
		expect(editParams.mask).toBeDefined()
		expect(events.at(-1)).toMatchObject({
			type: "completed",
			outputs: [{ source: { kind: "base64", mimeType: "image/webp" } }],
		})
	})

	it("fails closed before calling Images API with the subscription alias", async () => {
		const generate = vi.fn()
		const edit = vi.fn()
		const adapter = new OpenAIImageGenerationAdapter({
			profile: profile(),
			modelId: "gpt-image-2-sub",
			client: client({ generate, edit }),
		})

		const events = await collect(
			adapter.generate(request({ modelId: "gpt-image-2-sub" }), { signal: new AbortController().signal }),
		)

		expect(generate).not.toHaveBeenCalled()
		expect(edit).not.toHaveBeenCalled()
		expect(events.at(-1)).toMatchObject({ type: "failed", error: { code: "invalid_request", retryable: false } })
	})

	it("maps provider rate limits to a retryable image error event", async () => {
		const error = Object.assign(new Error("Too many requests"), { status: 429, code: "rate_limit_exceeded" })
		const generate = vi.fn(async () => {
			throw error
		})
		const adapter = new OpenAIImageGenerationAdapter({
			profile: profile(),
			modelId: "gpt-image-2",
			client: client({ generate, edit: vi.fn() }),
		})

		const events = await collect(adapter.generate(request(), { signal: new AbortController().signal }))

		expect(events.at(-1)).toMatchObject({
			type: "failed",
			error: { code: "rate_limited", retryable: true, providerCode: "rate_limit_exceeded" },
		})
	})
})
