import { resolveTaskArtifactPath } from "@core/artifacts/runtime"
import type { ToolUse } from "@core/assistant-message"
import type {
	ImageBackground,
	ImageGenerationRequest,
	ImageOutputFormat,
	ImageQuality,
	ImageReferenceInput,
} from "@core/image-generation/contracts"
import { ImageGenerationError } from "@core/image-generation/contracts"
import { DEFAULT_IMAGE_GENERATION_SIZE } from "@core/image-generation/ImageGenerationSizes"
import { formatResponse } from "@core/prompts/responses"
import type { ClineSayTool } from "@shared/ExtensionMessage"
import { IMAGE_GENERATION_PRESENTATION_SCHEMA_VERSION, type ImageGenerationPresentationV1 } from "@shared/image-generation"
import { ClineDefaultTool } from "@shared/tools"
import type { ToolResponse } from "../../index"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

const BACKGROUNDS = new Set<ImageBackground>(["auto", "opaque", "transparent"])
const OUTPUT_FORMATS = new Set<ImageOutputFormat>(["png", "jpeg", "webp"])
const QUALITIES = new Set<ImageQuality>(["auto", "low", "medium", "high"])

function parsePositiveInteger(value: string | undefined, name: string, fallback?: number): number | undefined {
	if (value === undefined || value.trim() === "") return fallback
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new ImageGenerationError({
			code: "invalid_request",
			message: `Image generation parameter ${name} must be a positive integer.`,
			retryable: false,
		})
	}
	return parsed
}

function parseCompression(value: string | undefined): number | undefined {
	if (value === undefined || value.trim() === "") return undefined
	const parsed = Number(value)
	if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 100) {
		throw new ImageGenerationError({
			code: "invalid_request",
			message: "Image output compression must be an integer between 0 and 100.",
			retryable: false,
		})
	}
	return parsed
}

function parseReferences(value: string | undefined): ImageReferenceInput[] {
	if (!value?.trim()) return []
	let parsed: unknown
	try {
		parsed = JSON.parse(value)
	} catch (error) {
		throw new ImageGenerationError({
			code: "invalid_request",
			message: "reference_artifact_ids must be a JSON array of Artifact IDs.",
			retryable: false,
			providerCode: error instanceof Error ? error.name : undefined,
		})
	}
	if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string" || !item.trim())) {
		throw new ImageGenerationError({
			code: "invalid_request",
			message: "reference_artifact_ids must contain only non-empty Artifact IDs.",
			retryable: false,
		})
	}
	return parsed.map((artifactId) => ({ artifactId, role: "reference" }))
}

function parseEnum<T extends string>(value: string | undefined, allowed: ReadonlySet<T>, name: string): T | undefined {
	if (!value?.trim()) return undefined
	if (!allowed.has(value as T)) {
		throw new ImageGenerationError({
			code: "invalid_request",
			message: `Image generation parameter ${name} is invalid.`,
			retryable: false,
		})
	}
	return value as T
}

function createToolPresentation(imageGeneration: ImageGenerationPresentationV1): ClineSayTool {
	return {
		tool: "generateImage",
		content: imageGeneration.prompt,
		imageGeneration,
		operationIsLocatedInWorkspace: false,
	}
}

export class GenerateImageToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.GENERATE_IMAGE

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.prompt ?? ""}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		if (uiHelpers.getConfig().isSubagentExecution) return
		const prompt = uiHelpers.removeClosingTag(block, "prompt", block.params.prompt)
		const count = Number(block.params.count)
		const presentation = createToolPresentation({
			schemaVersion: IMAGE_GENERATION_PRESENTATION_SCHEMA_VERSION,
			status: "queued",
			requestId: block.dline_tid,
			prompt,
			count: Number.isSafeInteger(count) && count > 0 ? count : 1,
		})
		const message = JSON.stringify(presentation)
		await uiHelpers.say("tool", message, undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		let activePresentation: ImageGenerationPresentationV1 | undefined
		const previewsBySequence = new Map<number, NonNullable<ImageGenerationPresentationV1["previews"]>[number]>()
		try {
			const prompt = block.params.prompt?.trim()
			if (!prompt) {
				config.taskState.consecutiveMistakeCount++
				return await config.callbacks.sayAndCreateMissingParamError(this.name, "prompt", undefined, block.ts)
			}

			const resolved = config.services.imageGenerationService.resolveProfile(block.params.profile?.trim() || undefined)
			const count = parsePositiveInteger(block.params.count, "count", 1) ?? 1
			const width = parsePositiveInteger(block.params.width, "width")
			const height = parsePositiveInteger(block.params.height, "height")
			if ((width === undefined) !== (height === undefined)) {
				throw new ImageGenerationError({
					code: "invalid_request",
					message: "Image generation width and height must be provided together.",
					retryable: false,
				})
			}
			const outputFormat = parseEnum(block.params.output_format, OUTPUT_FORMATS, "output_format") ?? "png"
			const outputCompression = parseCompression(block.params.output_compression)
			const background = parseEnum(block.params.background, BACKGROUNDS, "background") ?? "auto"
			if (outputCompression !== undefined && outputFormat !== "jpeg" && outputFormat !== "webp") {
				throw new ImageGenerationError({
					code: "invalid_request",
					message: "Image output compression is only supported for JPEG and WebP.",
					retryable: false,
				})
			}
			if (background === "transparent" && outputFormat === "jpeg") {
				throw new ImageGenerationError({
					code: "invalid_request",
					message: "Transparent image output requires PNG or WebP format.",
					retryable: false,
				})
			}
			const references = parseReferences(block.params.reference_artifact_ids)
			if (block.params.mask_artifact_id?.trim()) {
				references.push({ artifactId: block.params.mask_artifact_id.trim(), role: "mask" })
			}
			const request: ImageGenerationRequest = {
				requestId: block.dline_tid,
				profileId: resolved.profile.id,
				providerId: resolved.profile.provider,
				modelId: resolved.model.id,
				operation: references.length > 0 ? "edit" : "generate",
				prompt,
				count,
				size: width !== undefined && height !== undefined ? { width, height } : DEFAULT_IMAGE_GENERATION_SIZE,
				aspectRatio: block.params.aspect_ratio?.trim() || undefined,
				quality: parseEnum(block.params.quality, QUALITIES, "quality") ?? "auto",
				background,
				outputFormat,
				outputCompression,
				references,
			}

			activePresentation = {
				schemaVersion: IMAGE_GENERATION_PRESENTATION_SCHEMA_VERSION,
				status: "queued",
				requestId: request.requestId,
				prompt,
				profileId: resolved.profile.id,
				providerId: request.providerId,
				modelId: request.modelId,
				count,
			}
			const presentation = createToolPresentation(activePresentation)
			const message = JSON.stringify(presentation)
			await config.callbacks.say("tool", message, undefined, undefined, false, block.ts)

			config.taskState.consecutiveMistakeCount = 0
			activePresentation = { ...activePresentation, status: "started" }
			await config.callbacks.say(
				"tool",
				JSON.stringify(createToolPresentation(activePresentation)),
				undefined,
				undefined,
				false,
				block.ts,
			)
			const result = await config.services.imageGenerationService.generate(request, {
				signal: config.taskState.operationSignal,
				onProgress: async (event) => {
					if (event.type !== "preview" || !activePresentation) return
					if (event.preview) previewsBySequence.set(event.preview.sequence, event.preview)
					activePresentation = {
						...activePresentation,
						status: "preview",
						previews: [...previewsBySequence.values()].sort((left, right) => left.sequence - right.sequence),
					}
					await config.callbacks.say(
						"tool",
						JSON.stringify(createToolPresentation(activePresentation)),
						undefined,
						undefined,
						false,
						block.ts,
					)
				},
			})
			activePresentation = {
				...activePresentation,
				status: "completed",
				artifacts: result.artifacts.map((artifact) => ({
					id: artifact.id,
					mimeType: artifact.mimeType,
					format: artifact.format,
					byteLength: artifact.byteLength,
					width: artifact.width,
					height: artifact.height,
					revisedPrompt: artifact.provenance?.revisedPrompt,
				})),
				usage: result.usage,
			}
			await config.callbacks.say(
				"tool",
				JSON.stringify(createToolPresentation(activePresentation)),
				undefined,
				undefined,
				false,
				block.ts,
			)
			return formatResponse.toolResult(
				JSON.stringify({
					requestId: result.requestId,
					profileId: result.profileId,
					providerId: result.providerId,
					modelId: result.modelId,
					reference_artifact_ids: result.artifacts.map((artifact) => artifact.id),
					artifacts: result.artifacts.map((artifact) => ({
						id: artifact.id,
						path: resolveTaskArtifactPath(config.taskId, artifact.relativePath),
						mimeType: artifact.mimeType,
						format: artifact.format,
						byteLength: artifact.byteLength,
						width: artifact.width,
						height: artifact.height,
						revisedPrompt: artifact.provenance?.revisedPrompt,
					})),
					usage: result.usage,
				}),
			)
		} catch (error) {
			const safeError =
				error instanceof ImageGenerationError
					? error
					: new ImageGenerationError({
							code: "provider_error",
							message: "Image generation failed.",
							retryable: false,
						})
			const message = safeError.message
			if (activePresentation) {
				const isCancelled = safeError.code === "cancelled"
				// The service deletes every stored preview for a request that did not
				// commit a result, so a terminal presentation must stop advertising
				// those IDs. Keeping them would make the webview request bytes that no
				// longer exist, once per state broadcast.
				const { previews: _discardedPreviews, ...withoutPreviews } = activePresentation
				activePresentation = {
					...withoutPreviews,
					status: isCancelled ? "cancelled" : "failed",
					error: {
						message,
						code: safeError.code,
						retryable: safeError.retryable,
					},
				}
				await config.callbacks
					.say(
						"tool",
						JSON.stringify(createToolPresentation(activePresentation)),
						undefined,
						undefined,
						false,
						block.ts,
					)
					.catch(() => undefined)
			}
			return formatResponse.toolError(message)
		}
	}
}
