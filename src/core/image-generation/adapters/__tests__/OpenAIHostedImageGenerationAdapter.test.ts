import { GPT_IMAGE_2_5_MODEL_ID, GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID } from "@shared/image-generation"
import type { ApiProfile } from "@shared/proto/dline/profile"
import OpenAI from "openai"
import { describe, expect, it, vi } from "vitest"
import type { ImageGenerationEvent, ImageGenerationRequest } from "../../contracts"
import { OpenAIHostedImageGenerationAdapter } from "../OpenAIHostedImageGenerationAdapter"

function profile(): ApiProfile {
	return {
		id: "openai-responses-profile",
		name: "OpenAI Responses",
		provider: "openai",
		apiKey: "test-key",
		baseUrl: "https://api.openai.test/v1",
		modelId: "gpt-5",
		enabled: true,
		usedFor: ["act"],
	} as ApiProfile
}

function request(overrides: Partial<ImageGenerationRequest> = {}): ImageGenerationRequest {
	return {
		requestId: "request-1",
		profileId: "openai-responses-profile",
		providerId: "openai",
		modelId: "gpt-image-2",
		operation: "generate",
		prompt: "A blue owl",
		count: 1,
		size: { width: 2048, height: 1152 },
		quality: "high",
		background: "opaque",
		outputFormat: "webp",
		outputCompression: 80,
		references: [],
		...overrides,
	}
}

async function collect(events: AsyncIterable<ImageGenerationEvent>): Promise<ImageGenerationEvent[]> {
	const result: ImageGenerationEvent[] = []
	for await (const event of events) result.push(event)
	return result
}

function stream(events: unknown[]): AsyncIterable<OpenAI.Responses.ResponseStreamEvent> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event as OpenAI.Responses.ResponseStreamEvent
		},
	}
}

describe("OpenAIHostedImageGenerationAdapter", () => {
	it("maps AI-selected output options to one forced store:false hosted request with the dedicated image tool model", async () => {
		let capturedParams: OpenAI.Responses.ResponseCreateParamsStreaming | undefined
		const create = vi.fn(async (params: OpenAI.Responses.ResponseCreateParamsStreaming) => {
			capturedParams = params
			return stream([
				...Array.from({ length: 3 }, (_, index) => ({
					type: "response.image_generation_call.partial_image",
					item_id: "ig-1",
					partial_image_index: index,
					partial_image_b64: `partial-${index}`,
				})),
				{
					type: "response.output_item.done",
					item: { id: "ig-1", type: "image_generation_call", status: "completed", result: "final-image" },
				},
			])
		})
		const adapter = new OpenAIHostedImageGenerationAdapter({
			profile: profile(),
			modelId: "gpt-image-2",
			client: { responses: { create } },
		})

		const events = await collect(adapter.generate(request(), { signal: new AbortController().signal }))

		expect(capturedParams).toMatchObject({
			model: "gpt-5",
			store: false,
			stream: true,
			tool_choice: { type: "image_generation" },
			tools: [
				{
					type: "image_generation",
					model: "gpt-image-2",
					action: "generate",
					partial_images: 3,
					size: "2048x1152",
					quality: "high",
					background: "opaque",
					output_format: "webp",
					output_compression: 80,
				},
			],
		})
		expect((capturedParams?.tools?.[0] as { model?: string }).model).toBe("gpt-image-2")
		expect(
			events.filter((event) => event.type === "preview").map((event) => (event.type === "preview" ? event.sequence : -1)),
		).toEqual([0, 1, 2])
		expect(events.at(-1)).toMatchObject({
			type: "completed",
			outputs: [{ source: { kind: "base64", data: "final-image", mimeType: "image/webp" } }],
		})
	})

	it.each([
		GPT_IMAGE_2_5_MODEL_ID,
		GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID,
	])("uses subscription model %s to send a verbatim ratio phrase without an API size constraint", async (modelId) => {
		let capturedParams: OpenAI.Responses.ResponseCreateParamsStreaming | undefined
		const create = vi.fn(async (params: OpenAI.Responses.ResponseCreateParamsStreaming) => {
			capturedParams = params
			return stream([
				{
					type: "response.output_item.done",
					item: { id: "ig-sub", type: "image_generation_call", status: "completed", result: "final-image" },
				},
			])
		})
		const adapter = new OpenAIHostedImageGenerationAdapter({
			profile: profile(),
			modelId,
			client: { responses: { create } },
		})

		await collect(adapter.generate(request({ modelId }), { signal: new AbortController().signal }))

		expect(capturedParams?.input).toEqual([
			{
				role: "user",
				content: [{ type: "input_text", text: "A blue owl\n\n横版 16:9" }],
			},
		])
		expect(capturedParams?.tools?.[0]).toMatchObject({ type: "image_generation", model: "gpt-image-2" })
		expect(capturedParams?.tools?.[0]).not.toHaveProperty("size")
	})

	it("retries one retryable provider failure before any partial image", async () => {
		const create = vi
			.fn()
			.mockRejectedValueOnce({ status: 503 })
			.mockResolvedValueOnce(
				stream([
					{
						type: "response.output_item.done",
						item: { id: "ig-retry", type: "image_generation_call", status: "completed", result: "final-image" },
					},
				]),
			)
		const adapter = new OpenAIHostedImageGenerationAdapter({
			profile: profile(),
			modelId: "gpt-image-2",
			client: { responses: { create } },
		})

		const events = await collect(adapter.generate(request(), { signal: new AbortController().signal }))

		expect(create).toHaveBeenCalledTimes(2)
		expect(events.at(-1)).toMatchObject({ type: "completed" })
	})

	it("does not retry a stream failure after a partial image was received", async () => {
		const create = vi.fn(async () => ({
			async *[Symbol.asyncIterator]() {
				yield {
					type: "response.image_generation_call.partial_image",
					item_id: "ig-partial-failure",
					partial_image_index: 0,
					partial_image_b64: "partial-image",
				} as OpenAI.Responses.ResponseStreamEvent
				throw { status: 503 }
			},
		}))
		const adapter = new OpenAIHostedImageGenerationAdapter({
			profile: profile(),
			modelId: "gpt-image-2",
			client: { responses: { create } },
		})

		const events = await collect(adapter.generate(request(), { signal: new AbortController().signal }))

		expect(create).toHaveBeenCalledTimes(1)
		expect(events.map((event) => event.type)).toContain("preview")
		expect(events.at(-1)).toMatchObject({ type: "failed", error: { code: "provider_error", retryable: true } })
	})

	it.each([
		{ name: "multiple outputs", overrides: { count: 2 } },
		{
			name: "mask artifacts",
			overrides: { references: [{ artifactId: `image:sha256:${"a".repeat(64)}`, role: "mask" as const }] },
		},
	])("fails closed before the provider call for unsupported $name", async ({ overrides }) => {
		const create = vi.fn()
		const adapter = new OpenAIHostedImageGenerationAdapter({
			profile: profile(),
			modelId: "gpt-image-2",
			client: { responses: { create } },
		})

		const events = await collect(adapter.generate(request(overrides), { signal: new AbortController().signal }))

		expect(create).not.toHaveBeenCalled()
		expect(events.at(-1)).toMatchObject({ type: "failed", error: { code: "invalid_request", retryable: false } })
	})
})
