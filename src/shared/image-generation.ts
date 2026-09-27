export const IMAGE_GENERATION_PRESENTATION_SCHEMA_VERSION = 1 as const
export const GPT_IMAGE_1_MODEL_ID = "gpt-image-1"
export const GPT_IMAGE_2_MODEL_ID = "gpt-image-2"
export const GPT_IMAGE_2_5_MODEL_ID = "gpt-image-2.5"
/** @deprecated Stored-profile compatibility only; new configuration uses a real model ID plus ImageGenerationSource. */
export const GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID = "gpt-image-2-sub"

export type ImageGenerationPresentationStatus =
	| "awaiting_approval"
	| "queued"
	| "started"
	| "preview"
	| "completed"
	| "failed"
	| "cancelled"
	| "rejected"

export interface ImageGenerationArtifactPresentationV1 {
	id: string
	mimeType: string
	format: "png" | "jpeg" | "webp"
	byteLength: number
	width: number
	height: number
	revisedPrompt?: string
}

export interface ImageGenerationPreviewPresentationV1 {
	id: string
	mimeType: "image/png" | "image/jpeg" | "image/webp"
	width: number
	height: number
	sequence: number
}

export interface ImageGenerationUsagePresentationV1 {
	imageCount: number
	totalOutputBytes?: number
	estimatedCostUsd?: number
	currency?: string
}

export interface ImageGenerationErrorPresentationV1 {
	code?: string
	message: string
	retryable?: boolean
}

export interface ImageGenerationPresentationV1 {
	schemaVersion: typeof IMAGE_GENERATION_PRESENTATION_SCHEMA_VERSION
	status: ImageGenerationPresentationStatus
	requestId: string
	prompt: string
	profileId?: string
	providerId?: string
	modelId?: string
	count: number
	artifacts?: ImageGenerationArtifactPresentationV1[]
	previews?: ImageGenerationPreviewPresentationV1[]
	/** Legacy single-preview field retained for stored message compatibility. */
	preview?: ImageGenerationPreviewPresentationV1
	usage?: ImageGenerationUsagePresentationV1
	error?: ImageGenerationErrorPresentationV1
}

const STATUSES = new Set<ImageGenerationPresentationStatus>([
	"awaiting_approval",
	"queued",
	"started",
	"preview",
	"completed",
	"failed",
	"cancelled",
	"rejected",
])
const FORMATS = new Set<ImageGenerationArtifactPresentationV1["format"]>(["png", "jpeg", "webp"])

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function parseArtifact(value: unknown): ImageGenerationArtifactPresentationV1 | undefined {
	if (!isRecord(value)) return undefined
	if (
		!isNonEmptyString(value.id) ||
		!isNonEmptyString(value.mimeType) ||
		!FORMATS.has(value.format as ImageGenerationArtifactPresentationV1["format"]) ||
		!isNonNegativeInteger(value.byteLength) ||
		!isPositiveInteger(value.width) ||
		!isPositiveInteger(value.height) ||
		(value.revisedPrompt !== undefined && typeof value.revisedPrompt !== "string")
	) {
		return undefined
	}
	return {
		id: value.id,
		mimeType: value.mimeType,
		format: value.format as ImageGenerationArtifactPresentationV1["format"],
		byteLength: value.byteLength,
		width: value.width,
		height: value.height,
		...(typeof value.revisedPrompt === "string" ? { revisedPrompt: value.revisedPrompt } : {}),
	}
}

function parsePreview(value: unknown): ImageGenerationPreviewPresentationV1 | undefined {
	if (value === undefined) return undefined
	if (
		!isRecord(value) ||
		!isNonEmptyString(value.id) ||
		!new Set(["image/png", "image/jpeg", "image/webp"]).has(value.mimeType as string) ||
		!isPositiveInteger(value.width) ||
		!isPositiveInteger(value.height) ||
		!isNonNegativeInteger(value.sequence)
	) {
		return undefined
	}
	return {
		id: value.id,
		mimeType: value.mimeType as ImageGenerationPreviewPresentationV1["mimeType"],
		width: value.width,
		height: value.height,
		sequence: value.sequence,
	}
}

function parseUsage(value: unknown): ImageGenerationUsagePresentationV1 | undefined {
	if (value === undefined) return undefined
	if (!isRecord(value) || !isNonNegativeInteger(value.imageCount)) return undefined
	if (value.totalOutputBytes !== undefined && !isNonNegativeInteger(value.totalOutputBytes)) return undefined
	if (value.estimatedCostUsd !== undefined && (typeof value.estimatedCostUsd !== "number" || value.estimatedCostUsd < 0)) {
		return undefined
	}
	if (value.currency !== undefined && typeof value.currency !== "string") return undefined
	return {
		imageCount: value.imageCount,
		...(typeof value.totalOutputBytes === "number" ? { totalOutputBytes: value.totalOutputBytes } : {}),
		...(typeof value.estimatedCostUsd === "number" ? { estimatedCostUsd: value.estimatedCostUsd } : {}),
		...(typeof value.currency === "string" ? { currency: value.currency } : {}),
	}
}

function parseError(value: unknown): ImageGenerationErrorPresentationV1 | undefined {
	if (value === undefined) return undefined
	if (!isRecord(value) || !isNonEmptyString(value.message)) return undefined
	if (value.code !== undefined && typeof value.code !== "string") return undefined
	if (value.retryable !== undefined && typeof value.retryable !== "boolean") return undefined
	return {
		message: value.message,
		...(typeof value.code === "string" ? { code: value.code } : {}),
		...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
	}
}

export function parseImageGenerationPresentation(value: unknown): ImageGenerationPresentationV1 | undefined {
	if (!isRecord(value)) return undefined
	if (
		value.schemaVersion !== IMAGE_GENERATION_PRESENTATION_SCHEMA_VERSION ||
		!STATUSES.has(value.status as ImageGenerationPresentationStatus) ||
		!isNonEmptyString(value.requestId) ||
		typeof value.prompt !== "string" ||
		!isPositiveInteger(value.count)
	) {
		return undefined
	}
	for (const field of ["profileId", "providerId", "modelId"] as const) {
		if (value[field] !== undefined && typeof value[field] !== "string") return undefined
	}
	const artifacts =
		value.artifacts === undefined ? undefined : Array.isArray(value.artifacts) ? value.artifacts.map(parseArtifact) : []
	if (artifacts?.some((artifact) => artifact === undefined)) return undefined
	const previews =
		value.previews === undefined ? undefined : Array.isArray(value.previews) ? value.previews.map(parsePreview) : []
	if (previews?.some((preview) => preview === undefined)) return undefined
	const preview = parsePreview(value.preview)
	if (value.preview !== undefined && !preview) return undefined
	const usage = parseUsage(value.usage)
	if (value.usage !== undefined && !usage) return undefined
	const error = parseError(value.error)
	if (value.error !== undefined && !error) return undefined
	return {
		schemaVersion: IMAGE_GENERATION_PRESENTATION_SCHEMA_VERSION,
		status: value.status as ImageGenerationPresentationStatus,
		requestId: value.requestId,
		prompt: value.prompt,
		count: value.count,
		...(typeof value.profileId === "string" ? { profileId: value.profileId } : {}),
		...(typeof value.providerId === "string" ? { providerId: value.providerId } : {}),
		...(typeof value.modelId === "string" ? { modelId: value.modelId } : {}),
		...(artifacts ? { artifacts: artifacts as ImageGenerationArtifactPresentationV1[] } : {}),
		...(previews ? { previews: previews as ImageGenerationPreviewPresentationV1[] } : {}),
		...(preview ? { preview } : {}),
		...(usage ? { usage } : {}),
		...(error ? { error } : {}),
	}
}

export function parseImageGenerationToolText(text: string | undefined): ImageGenerationPresentationV1 | undefined {
	if (!text) return undefined
	try {
		const parsed = JSON.parse(text) as unknown
		if (!isRecord(parsed) || parsed.tool !== "generateImage") return undefined
		return parseImageGenerationPresentation(parsed.imageGeneration)
	} catch {
		return undefined
	}
}
