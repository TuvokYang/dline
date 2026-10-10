import { createOpenAIClientForProfile } from "@core/api/providers/openai-client-factory"
import { GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID } from "@shared/image-generation"
import OpenAI, { toFile } from "openai"
import type {
    ImageGenerationAdapter,
    ImageGenerationAdapterConfig,
    ImageGenerationEvent,
    ImageGenerationRequest,
    ImageProviderOutput,
} from "../contracts"
import { ImageGenerationError } from "../contracts"
import { resolveOpenAIImageSize } from "../ImageGenerationSizes"

interface OpenAIImageClient {
    images: OpenAI["images"]
}

interface OpenAIImageGenerationAdapterOptions extends ImageGenerationAdapterConfig {
    client?: OpenAIImageClient
}

interface OpenAiProviderError {
    status?: unknown
    code?: unknown
    type?: unknown
    message?: unknown
    error?: { code?: unknown; type?: unknown; message?: unknown }
}

function timestamp(): number {
    return Date.now()
}

function mimeTypeForFormat(format: ImageGenerationRequest["outputFormat"]): string {
    switch (format) {
        case "jpeg":
            return "image/jpeg"
        case "webp":
            return "image/webp"
        default:
            return "image/png"
    }
}

function qualityForRequest(request: ImageGenerationRequest): "low" | "medium" | "high" | "auto" | undefined {
    switch (request.quality) {
        case undefined:
            return undefined
        case "low":
        case "medium":
        case "high":
        case "auto":
            return request.quality
        default:
            throw new ImageGenerationError({
                code: "invalid_request",
                message: `OpenAI image quality "${request.quality}" is not supported.`,
                retryable: false,
            })
    }
}

function providerCode(error: OpenAiProviderError): string | undefined {
    const candidate = error.error?.code ?? error.code ?? error.error?.type ?? error.type
    if (typeof candidate !== "string") return undefined
    const normalized = candidate.trim()
    return /^[a-zA-Z0-9._-]{1,64}$/.test(normalized) ? normalized : undefined
}

function providerStatus(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) return undefined
    const status = (error as OpenAiProviderError).status
    return typeof status === "number" ? status : undefined
}

export function mapOpenAIImageProviderError(error: unknown): ImageGenerationError {
    const status = providerStatus(error)
    const code = providerCode((typeof error === "object" && error !== null ? error : {}) as OpenAiProviderError)
    if (status === 429 || code === "rate_limit_exceeded" || code === "rate_limit") {
        return new ImageGenerationError({
            code: "rate_limited",
            message: "OpenAI image generation was rate limited.",
            retryable: true,
            providerCode: code,
        })
    }
    if (status === 400 || status === 422) {
        return new ImageGenerationError({
            code: "invalid_request",
            message: "OpenAI image generation request was rejected.",
            retryable: false,
            providerCode: code,
        })
    }
    if (status !== undefined && status >= 500) {
        return new ImageGenerationError({
            code: "provider_error",
            message:
                status === 503
                    ? "OpenAI image generation is unavailable at the configured endpoint (HTTP 503)."
                    : "OpenAI image generation failed at the provider.",
            retryable: true,
            providerCode: code,
        })
    }
    return new ImageGenerationError({
        code: "provider_error",
        message: "OpenAI image generation failed.",
        retryable: false,
        providerCode: code,
    })
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new ImageGenerationError({ code: "cancelled", message: "Image generation was cancelled.", retryable: false })
    }
}

function normalizeOutputs(
    request: ImageGenerationRequest,
    data: Array<{ b64_json?: string; url?: string; revised_prompt?: string }> | undefined,
): ImageProviderOutput[] {
    if (!data?.length) {
        throw new ImageGenerationError({
            code: "invalid_response",
            message: "OpenAI image generation returned no image data.",
            retryable: false,
        })
    }
    const mimeType = mimeTypeForFormat(request.outputFormat)
    return data.map((image, index) => {
        if (typeof image.b64_json === "string" && image.b64_json.length > 0) {
            return {
                id: `openai-image-${index}`,
                source: { kind: "base64", data: image.b64_json, mimeType },
                width: request.size?.width,
                height: request.size?.height,
                revisedPrompt: image.revised_prompt,
            }
        }
        if (typeof image.url === "string" && image.url.length > 0) {
            return {
                id: `openai-image-${index}`,
                source: { kind: "url", url: image.url, mimeType },
                width: request.size?.width,
                height: request.size?.height,
                revisedPrompt: image.revised_prompt,
            }
        }
        throw new ImageGenerationError({
            code: "invalid_response",
            message: "OpenAI image generation returned an image without usable data.",
            retryable: false,
        })
    })
}

export class OpenAIImageGenerationAdapter implements ImageGenerationAdapter {
    private readonly profile: ImageGenerationAdapterConfig["profile"]
    private readonly modelId: string
    private readonly injectedClient?: OpenAIImageClient
    private readonly resolveReference?: ImageGenerationAdapterConfig["resolveReference"]
    private client?: OpenAIImageClient

    constructor(options: OpenAIImageGenerationAdapterOptions) {
        this.profile = options.profile
        this.modelId = options.modelId
        this.injectedClient = options.client
        this.resolveReference = options.resolveReference
    }

    async *generate(request: ImageGenerationRequest, context: { signal: AbortSignal }): AsyncIterable<ImageGenerationEvent> {
        const startedAt = timestamp()
        yield { type: "queued", requestId: request.requestId, timestampMs: startedAt }
        try {
            throwIfAborted(context.signal)
            if (this.modelId === GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID) {
                throw new ImageGenerationError({
                    code: "invalid_request",
                    message: "GPT Image 2 Subscription requires the Current Responses image source.",
                    retryable: false,
                })
            }
            yield {
                type: "started",
                requestId: request.requestId,
                timestampMs: timestamp(),
                providerId: this.profile.provider,
                modelId: this.modelId,
            }
            const response =
                request.operation === "edit"
                    ? await this.edit(request, context.signal)
                    : await this.generateImage(request, context.signal)
            throwIfAborted(context.signal)
            const outputs = normalizeOutputs(request, response.data)
            yield {
                type: "completed",
                requestId: request.requestId,
                timestampMs: timestamp(),
                outputs,
                usage: { imageCount: outputs.length },
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

    private getClient(): OpenAIImageClient {
        if (this.injectedClient) return this.injectedClient
        if (!this.client) this.client = createOpenAIClientForProfile(this.profile)
        return this.client
    }

    private async generateImage(request: ImageGenerationRequest, signal: AbortSignal) {
        const client = this.getClient()
        const useCodexDefaults = this.modelId === "gpt-image-2"
        const size = resolveOpenAIImageSize(this.modelId, request.size)
        const quality = qualityForRequest(request) ?? (useCodexDefaults ? "auto" : undefined)
        const background = request.background ?? (useCodexDefaults ? "auto" : undefined)
        return client.images.generate(
            {
                model: this.modelId,
                prompt: request.prompt,
                ...(request.count > 1 ? { n: request.count } : {}),
                ...(size ? { size } : {}),
                ...(quality ? { quality } : {}),
                ...(background ? { background } : {}),
                ...(request.outputFormat && (!useCodexDefaults || request.outputFormat !== "png")
                    ? { output_format: request.outputFormat }
                    : {}),
                ...(request.outputCompression === undefined ? {} : { output_compression: request.outputCompression }),
            },
            { signal },
        )
    }

    private async edit(request: ImageGenerationRequest, signal: AbortSignal) {
        if (!this.resolveReference) {
            throw new ImageGenerationError({
                code: "invalid_request",
                message: "Image editing requires an artifact reference resolver.",
                retryable: false,
            })
        }
        const imageReferences = request.references.filter((reference) => reference.role === "reference")
        if (imageReferences.length === 0) {
            throw new ImageGenerationError({
                code: "invalid_request",
                message: "Image editing requires at least one reference image.",
                retryable: false,
            })
        }
        const resolved = await Promise.all(
            request.references.map(async (reference, index) => {
                const input = await this.resolveReference?.(reference.artifactId, signal)
                if (!input) {
                    throw new ImageGenerationError({
                        code: "invalid_request",
                        message: `Image artifact ${reference.artifactId} could not be resolved.`,
                        retryable: false,
                    })
                }
                return { reference, file: await toFile(input.bytes, `dline-image-${index}`, { type: input.mimeType }) }
            }),
        )
        const images = resolved.filter(({ reference }) => reference.role === "reference").map(({ file }) => file)
        const mask = resolved.find(({ reference }) => reference.role === "mask")?.file
        const size = resolveOpenAIImageSize(this.modelId, request.size)
        return this.getClient().images.edit(
            {
                model: this.modelId,
                image: images,
                prompt: request.prompt,
                n: request.count,
                ...(mask ? { mask } : {}),
                ...(size ? { size } : {}),
                ...(qualityForRequest(request) ? { quality: qualityForRequest(request) } : {}),
                ...(request.background ? { background: request.background } : {}),
                ...(request.outputFormat ? { output_format: request.outputFormat } : {}),
                ...(request.outputCompression === undefined ? {} : { output_compression: request.outputCompression }),
            },
            { signal },
        )
    }
}
