import { type GenerateContentParameters, type GenerateContentResponse, GoogleGenAI } from "@google/genai"
import type {
    ImageGenerationAdapter,
    ImageGenerationAdapterConfig,
    ImageGenerationEvent,
    ImageGenerationRequest,
    ImageProviderOutput,
} from "../contracts"
import { ImageGenerationError } from "../contracts"

interface GeminiInlineData {
    data?: string
    mimeType?: string
}

interface GeminiResponsePart {
    text?: string
    inlineData?: GeminiInlineData
}

export type GeminiGenerateContentParams = GenerateContentParameters

export interface GeminiImageClient {
    models: {
        generateContent(params: GenerateContentParameters): Promise<GenerateContentResponse>
    }
}

interface GeminiImageGenerationAdapterOptions extends ImageGenerationAdapterConfig {
    client?: GeminiImageClient
}

interface GeminiProviderError {
    status?: unknown
    code?: unknown
    message?: unknown
    error?: { code?: unknown; message?: unknown }
}

function timestamp(): number {
    return Date.now()
}

function providerCode(error: GeminiProviderError): string | undefined {
    const value = error.error?.code ?? error.code
    if (typeof value !== "string") return undefined
    const normalized = value.trim()
    return /^[a-zA-Z0-9._-]{1,64}$/.test(normalized) ? normalized : undefined
}

function mapProviderError(error: unknown): ImageGenerationError {
    const candidate = (typeof error === "object" && error !== null ? error : {}) as GeminiProviderError
    const status = typeof candidate.status === "number" ? candidate.status : undefined
    const code = providerCode(candidate)
    if (status === 429 || code === "RESOURCE_EXHAUSTED" || code === "RATE_LIMIT_EXCEEDED") {
        return new ImageGenerationError({
            code: "rate_limited",
            message: "Gemini image generation was rate limited.",
            retryable: true,
            providerCode: code,
        })
    }
    if (status === 400 || status === 422) {
        return new ImageGenerationError({
            code: "invalid_request",
            message: "Gemini image generation request was rejected.",
            retryable: false,
            providerCode: code,
        })
    }
    if (status !== undefined && status >= 500) {
        return new ImageGenerationError({
            code: "provider_error",
            message: "Gemini image generation failed at the provider.",
            retryable: true,
            providerCode: code,
        })
    }
    return new ImageGenerationError({
        code: "provider_error",
        message: "Gemini image generation failed.",
        retryable: false,
        providerCode: code,
    })
}

function throwIfAborted(signal: AbortSignal): void {
    if (signal.aborted) {
        throw new ImageGenerationError({ code: "cancelled", message: "Image generation was cancelled.", retryable: false })
    }
}

function toBase64(bytes: Uint8Array): string {
    return Buffer.from(bytes).toString("base64")
}

function outputMimeType(request: ImageGenerationRequest, inlineData: GeminiInlineData): string {
    if (typeof inlineData.mimeType === "string" && inlineData.mimeType.trim()) return inlineData.mimeType
    switch (request.outputFormat) {
        case "jpeg":
            return "image/jpeg"
        case "webp":
            return "image/webp"
        default:
            return "image/png"
    }
}

function normalizeOutputs(request: ImageGenerationRequest, response: GenerateContentResponse): ImageProviderOutput[] {
    const parts = response.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? []
    const revisedPrompt = parts.map((part) => part.text?.trim()).find((text): text is string => Boolean(text))
    const imageParts = parts.filter((part) => typeof part.inlineData?.data === "string" && part.inlineData.data.length > 0)
    if (imageParts.length === 0) {
        throw new ImageGenerationError({
            code: "invalid_response",
            message: "Gemini image generation returned no inline image data.",
            retryable: false,
        })
    }
    return imageParts.map((part, index) => ({
        id: `gemini-image-${index}`,
        source: {
            kind: "base64",
            data: part.inlineData?.data ?? "",
            mimeType: outputMimeType(request, part.inlineData ?? {}),
        },
        width: request.size?.width,
        height: request.size?.height,
        revisedPrompt,
    }))
}

export class GeminiImageGenerationAdapter implements ImageGenerationAdapter {
    private readonly profile: ImageGenerationAdapterConfig["profile"]
    private readonly modelId: string
    private readonly injectedClient?: GeminiImageClient
    private readonly resolveReference?: ImageGenerationAdapterConfig["resolveReference"]
    private client?: GeminiImageClient

    constructor(options: GeminiImageGenerationAdapterOptions) {
        this.profile = options.profile
        this.modelId = options.modelId
        this.injectedClient = options.client
        this.resolveReference = options.resolveReference
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
                modelId: this.modelId,
            }
            const response = await this.send(request, context.signal)
            throwIfAborted(context.signal)
            const outputs = normalizeOutputs(request, response)
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
                  : mapProviderError(error)
            if (mapped.code === "cancelled") {
                yield { type: "cancelled", requestId: request.requestId, timestampMs: timestamp(), reason: mapped.message }
            } else {
                yield { type: "failed", requestId: request.requestId, timestampMs: timestamp(), error: mapped.toDetails() }
            }
        }
    }

    private getClient(): GeminiImageClient {
        if (this.injectedClient) return this.injectedClient
        if (!this.client) {
            if (!this.profile.apiKey) {
                throw new ImageGenerationError({
                    code: "invalid_request",
                    message: "Gemini API key is required for image generation.",
                    retryable: false,
                })
            }
            const client = new GoogleGenAI({
                apiKey: this.profile.apiKey,
                httpOptions: this.profile.baseUrl ? { baseUrl: this.profile.baseUrl } : undefined,
            })
            this.client = client as unknown as GeminiImageClient
        }
        return this.client
    }

    private async send(request: ImageGenerationRequest, signal: AbortSignal): Promise<GenerateContentResponse> {
        const contents = await this.buildContents(request, signal)
        const params: GeminiGenerateContentParams = {
            model: this.modelId,
            contents,
            config: {
                abortSignal: signal,
                responseModalities: ["TEXT", "IMAGE"],
                candidateCount: request.count,
                ...(request.aspectRatio ? { imageConfig: { aspectRatio: request.aspectRatio } } : {}),
            },
        }
        return this.getClient().models.generateContent(params)
    }

    private async buildContents(
        request: ImageGenerationRequest,
        signal: AbortSignal,
    ): Promise<string | Array<{ text?: string; inlineData?: { data: string; mimeType: string } }>> {
        if (request.references.length === 0) return request.prompt
        if (!this.resolveReference) {
            throw new ImageGenerationError({
                code: "invalid_request",
                message: "Gemini image editing requires an artifact reference resolver.",
                retryable: false,
            })
        }
        const references = await Promise.all(
            request.references.map(async (reference) => {
                const content = await this.resolveReference?.(reference.artifactId, signal)
                if (!content) {
                    throw new ImageGenerationError({
                        code: "invalid_request",
                        message: `Image artifact ${reference.artifactId} could not be resolved.`,
                        retryable: false,
                    })
                }
                return { inlineData: { data: toBase64(content.bytes), mimeType: content.mimeType } }
            }),
        )
        return [{ text: request.prompt }, ...references]
    }
}
