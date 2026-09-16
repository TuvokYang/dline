import { createOpenAIClientForProfile } from "@core/api/providers/openai-client-factory"
import { GPT_IMAGE_2_5_MODEL_ID, GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID } from "@shared/image-generation"
import OpenAI from "openai"
import type {
	ImageGenerationAdapter,
	ImageGenerationAdapterConfig,
	ImageGenerationEvent,
	ImageGenerationRequest,
	ImageOutputFormat,
	ImageProviderOutput,
} from "../contracts"
import { ImageGenerationError } from "../contracts"
import { resolveOpenAIImageSize, resolveOpenAISubscriptionImagePrompt } from "../ImageGenerationSizes"
import { mapOpenAIImageProviderError } from "./OpenAIImageGenerationAdapter"

interface HostedResponsesClient {
	responses: {
		create(
			params: OpenAI.Responses.ResponseCreateParamsStreaming,
			options?: { signal?: AbortSignal },
		): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>>
	}
}

interface OpenAIHostedImageGenerationAdapterOptions extends ImageGenerationAdapterConfig {
	client?: HostedResponsesClient
}

function timestamp(): number {
	return Date.now()
}

function mimeTypeForFormat(format: ImageOutputFormat | undefined): string {
	switch (format) {
		case "jpeg":
			return "image/jpeg"
		case "webp":
			return "image/webp"
		default:
			return "image/png"
	}
}

function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) {
		throw new ImageGenerationError({ code: "cancelled", message: "Image generation was cancelled.", retryable: false })
	}
}

function revisedPromptFromItem(item: unknown): string | undefined {
	if (typeof item !== "object" || item === null) return undefined
	const value = (item as { revised_prompt?: unknown }).revised_prompt
	return typeof value === "string" && value.trim() ? value : undefined
}

function usesSubscriptionTransport(modelId: string): boolean {
	return modelId === GPT_IMAGE_2_5_MODEL_ID || modelId === GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID
}

/** Executes provider-hosted image generation behind the ordinary generate_image tool. */
export class OpenAIHostedImageGenerationAdapter implements ImageGenerationAdapter {
	private readonly profile: ImageGenerationAdapterConfig["profile"]
	private readonly imageModelId: string
	private readonly resolveReference?: ImageGenerationAdapterConfig["resolveReference"]
	private readonly injectedClient?: HostedResponsesClient
	private client?: HostedResponsesClient

	constructor(options: OpenAIHostedImageGenerationAdapterOptions) {
		this.profile = options.profile
		this.imageModelId = options.modelId
		this.resolveReference = options.resolveReference
		this.injectedClient = options.client
	}

	async *generate(request: ImageGenerationRequest, context: { signal: AbortSignal }): AsyncIterable<ImageGenerationEvent> {
		yield { type: "queued", requestId: request.requestId, timestampMs: timestamp() }
		try {
			throwIfAborted(context.signal)
			yield {
				type: "started",
				requestId: request.requestId,
				timestampMs: timestamp(),
				providerId: this.profile.provider,
				modelId: request.modelId,
			}

			const stream = await this.createResponseStream(await this.buildParams(request, context.signal), context.signal)
			let finalOutput: ImageProviderOutput | undefined
			for await (const event of stream) {
				throwIfAborted(context.signal)
				if (event.type === "response.image_generation_call.partial_image") {
					yield {
						type: "preview",
						requestId: request.requestId,
						timestampMs: timestamp(),
						sequence: event.partial_image_index,
						outputs: [
							{
								id: `openai-hosted-preview-${event.partial_image_index}`,
								source: {
									kind: "base64",
									data: event.partial_image_b64,
									mimeType: mimeTypeForFormat(request.outputFormat),
								},
							},
						],
					}
					continue
				}
				if (event.type === "response.output_item.done" && event.item.type === "image_generation_call") {
					if (event.item.status === "failed") {
						throw new ImageGenerationError({
							code: "provider_error",
							message: "OpenAI hosted image generation failed.",
							retryable: false,
						})
					}
					if (typeof event.item.result === "string" && event.item.result.length > 0) {
						finalOutput = {
							id: event.item.id,
							source: {
								kind: "base64",
								data: event.item.result,
								mimeType: mimeTypeForFormat(request.outputFormat),
							},
							revisedPrompt: revisedPromptFromItem(event.item),
						}
					}
					continue
				}
				if (event.type === "response.failed") {
					throw new ImageGenerationError({
						code: "provider_error",
						message: "OpenAI hosted image generation failed.",
						retryable: false,
						providerCode: event.response.error?.code ?? undefined,
					})
				}
			}

			if (!finalOutput) {
				throw new ImageGenerationError({
					code: "invalid_response",
					message: "OpenAI hosted image generation returned no final image.",
					retryable: false,
				})
			}
			yield {
				type: "completed",
				requestId: request.requestId,
				timestampMs: timestamp(),
				outputs: [finalOutput],
				usage: { imageCount: 1 },
			}
		} catch (error) {
			const mapped = context.signal.aborted
				? new ImageGenerationError({
						code: "cancelled",
						message: "Image generation was cancelled.",
						retryable: false,
					})
				: error instanceof ImageGenerationError
					? error
					: mapOpenAIImageProviderError(error)
			if (mapped.code === "cancelled") {
				yield { type: "cancelled", requestId: request.requestId, timestampMs: timestamp(), reason: mapped.message }
			} else {
				yield { type: "failed", requestId: request.requestId, timestampMs: timestamp(), error: mapped.toDetails() }
			}
		}
	}

	private getClient(): HostedResponsesClient {
		if (this.injectedClient) return this.injectedClient
		if (!this.client) this.client = createOpenAIClientForProfile(this.profile)
		return this.client
	}

	private async createResponseStream(
		params: OpenAI.Responses.ResponseCreateParamsStreaming,
		signal: AbortSignal,
	): Promise<AsyncIterable<OpenAI.Responses.ResponseStreamEvent>> {
		try {
			return await this.getClient().responses.create(params, { signal })
		} catch (error) {
			const mapped = mapOpenAIImageProviderError(error)
			if (signal.aborted || !mapped.retryable) throw error
			return this.getClient().responses.create(params, { signal })
		}
	}

	private async buildParams(
		request: ImageGenerationRequest,
		signal: AbortSignal,
	): Promise<OpenAI.Responses.ResponseCreateParamsStreaming> {
		if (!this.profile.modelId) {
			throw new ImageGenerationError({
				code: "invalid_request",
				message: "Current image generation requires a configured OpenAI Responses model.",
				retryable: false,
			})
		}
		if (request.count !== 1) {
			throw new ImageGenerationError({
				code: "invalid_request",
				message: "OpenAI Responses image generation currently supports exactly one image per request.",
				retryable: false,
			})
		}
		if (request.references.some((reference) => reference.role === "mask")) {
			throw new ImageGenerationError({
				code: "invalid_request",
				message: "OpenAI Responses image editing does not support mask artifacts.",
				retryable: false,
			})
		}
		const referenceContent = await Promise.all(
			request.references
				.filter((reference) => reference.role === "reference")
				.map(async (reference) => {
					if (!this.resolveReference) {
						throw new ImageGenerationError({
							code: "invalid_request",
							message: "Hosted image editing requires an artifact reference resolver.",
							retryable: false,
						})
					}
					const content = await this.resolveReference(reference.artifactId, signal)
					return {
						type: "input_image" as const,
						detail: "auto" as const,
						image_url: `data:${content.mimeType};base64,${Buffer.from(content.bytes).toString("base64")}`,
					}
				}),
		)
		const isSubscriptionModel = usesSubscriptionTransport(this.imageModelId)
		const providerPrompt = isSubscriptionModel
			? resolveOpenAISubscriptionImagePrompt(request.prompt, request.size, request.aspectRatio).prompt
			: request.prompt
		const input = [
			{
				role: "user" as const,
				content: [{ type: "input_text" as const, text: providerPrompt }, ...referenceContent],
			},
		] as OpenAI.Responses.ResponseInput
		const size = isSubscriptionModel ? undefined : resolveOpenAIImageSize(this.imageModelId, request.size)
		const tool = {
			type: "image_generation",
			model: isSubscriptionModel ? "gpt-image-2" : this.imageModelId,
			action: referenceContent.length > 0 ? "edit" : "generate",
			...(referenceContent.length > 0 ? { input_fidelity: "low" } : {}),
			partial_images: 3,
			...(size ? { size } : {}),
			quality: request.quality ?? "auto",
			background: request.background ?? "auto",
			output_format: request.outputFormat ?? "png",
			...(request.outputCompression === undefined ? {} : { output_compression: request.outputCompression }),
		} as OpenAI.Responses.Tool
		return {
			model: this.profile.modelId,
			input,
			tools: [tool],
			tool_choice: { type: "image_generation" },
			stream: true,
			store: false,
		}
	}
}
