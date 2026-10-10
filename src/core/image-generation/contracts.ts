import type { ImageGenerationCapabilities, ImagePricing } from "@shared/proto/dline/models/metadata"
import type { ApiProfile } from "@shared/proto/dline/profile"

export type ImageGenerationOperation = "generate" | "edit"
export type ImageOutputFormat = "png" | "jpeg" | "webp"
export type ImageQuality = "auto" | "low" | "medium" | "high"
export type ImageBackground = "auto" | "opaque" | "transparent"
export type ImageReferenceRole = "reference" | "mask"

export interface ImageGenerationSize {
    width: number
    height: number
}

export interface ImageReferenceInput {
    artifactId: string
    role: ImageReferenceRole
}

export interface ImageGenerationRequest {
    requestId: string
    profileId: string
    providerId: string
    modelId: string
    operation: ImageGenerationOperation
    prompt: string
    count: number
    size?: ImageGenerationSize
    aspectRatio?: string
    quality?: ImageQuality
    background?: ImageBackground
    outputFormat?: ImageOutputFormat
    outputCompression?: number
    references: ImageReferenceInput[]
}

export interface ImageGenerationBudget {
    limitUsd: number
    spentUsd: number
}

export interface ImageGenerationPreflight {
    estimatedCostUsd?: number
    currency?: string
}

export type ImageProviderOutputSource =
    | { kind: "bytes"; bytes: Uint8Array; mimeType: string }
    | { kind: "base64"; data: string; mimeType: string }
    | { kind: "url"; url: string; mimeType?: string }

export interface ImageProviderOutput {
    id: string
    source: ImageProviderOutputSource
    width?: number
    height?: number
    revisedPrompt?: string
}

export interface ImageGenerationUsage {
    imageCount: number
    totalOutputBytes?: number
    estimatedCostUsd?: number
    currency?: string
}

interface ImageGenerationEventBase {
    requestId: string
    timestampMs: number
}

export type ImageGenerationEvent =
    | (ImageGenerationEventBase & { type: "queued" })
    | (ImageGenerationEventBase & { type: "started"; providerId: string; modelId: string })
    | (ImageGenerationEventBase & { type: "preview"; sequence: number; outputs: ImageProviderOutput[] })
    | (ImageGenerationEventBase & { type: "completed"; outputs: ImageProviderOutput[]; usage: ImageGenerationUsage })
    | (ImageGenerationEventBase & { type: "failed"; error: ImageGenerationErrorDetails })
    | (ImageGenerationEventBase & { type: "cancelled"; reason: string })

export type ImageGenerationErrorCode =
    | "invalid_request"
    | "count_limit_exceeded"
    | "size_limit_exceeded"
    | "reference_limit_exceeded"
    | "unsupported_operation"
    | "unsupported_reference_images"
    | "unsupported_mask"
    | "unsupported_transparent_background"
    | "budget_exceeded"
    | "pricing_unavailable"
    | "concurrency_limit_exceeded"
    | "adapter_not_found"
    | "adapter_already_registered"
    | "content_filtered"
    | "rate_limited"
    | "provider_error"
    | "timeout"
    | "cancelled"
    | "invalid_response"

export interface ImageGenerationErrorDetails {
    code: ImageGenerationErrorCode
    message: string
    retryable: boolean
    providerCode?: string
}

export class ImageGenerationError extends Error {
    readonly code: ImageGenerationErrorCode
    readonly retryable: boolean
    readonly providerCode?: string

    constructor(details: ImageGenerationErrorDetails) {
        super(details.message)
        this.name = "ImageGenerationError"
        this.code = details.code
        this.retryable = details.retryable
        this.providerCode = details.providerCode
    }

    toDetails(): ImageGenerationErrorDetails {
        return {
            code: this.code,
            message: this.message,
            retryable: this.retryable,
            providerCode: this.providerCode,
        }
    }
}

export interface ImageGenerationPreview {
    id: string
    mimeType: "image/png" | "image/jpeg" | "image/webp"
    width: number
    height: number
    sequence: number
}

export interface ImageGenerationProgressEvent {
    type: "preview"
    requestId: string
    timestampMs: number
    preview?: ImageGenerationPreview
}

export interface ImageGenerationExecutionContext {
    signal: AbortSignal
    onProgress?: (event: ImageGenerationProgressEvent) => void | Promise<void>
}

export interface ImageGenerationAdapter {
    generate(request: ImageGenerationRequest, context: ImageGenerationExecutionContext): AsyncIterable<ImageGenerationEvent>
}

export interface ImageReferenceContent {
    bytes: Uint8Array
    mimeType: string
}

export type ImageReferenceResolver = (artifactId: string, signal: AbortSignal) => Promise<ImageReferenceContent>

export interface ImageGenerationAdapterConfig {
    profile: ApiProfile
    modelId: string
    resolveReference?: ImageReferenceResolver
}

export type ImageGenerationAdapterFactory = (config: ImageGenerationAdapterConfig) => ImageGenerationAdapter

export interface ImageGenerationPolicyInput {
    request: ImageGenerationRequest
    capabilities: ImageGenerationCapabilities
    pricing?: ImagePricing
    budget?: ImageGenerationBudget
}
