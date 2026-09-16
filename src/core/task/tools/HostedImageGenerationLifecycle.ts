import type { ApiStreamServerToolChunk } from "@core/api/transform/stream"
import type { ArtifactResolver } from "@core/artifacts/ArtifactResolver"
import { createTaskArtifactResolver, createTaskImagePreviewStore } from "@core/artifacts/runtime"
import type { ImageArtifact } from "@core/artifacts/TaskArtifactStore"
import type { TaskImagePreviewStore } from "@core/artifacts/TaskImagePreviewStore"
import type { ImageProviderOutput } from "@core/image-generation/contracts"
import type { ClineSayTool } from "@shared/ExtensionMessage"
import {
	IMAGE_GENERATION_PRESENTATION_SCHEMA_VERSION,
	type ImageGenerationArtifactPresentationV1,
	type ImageGenerationPresentationV1,
} from "@shared/image-generation"
import { ServerTool } from "@shared/proto/dline/models/metadata"

export interface HostedImageGenerationContext {
	readonly enabled: boolean
	readonly providerId: string
	readonly modelId: string
	readonly referenceArtifactIds?: readonly string[]
	readonly prompt?: string
}

export interface HostedImageGenerationUpdate {
	readonly dlineTid: string
	readonly partial: boolean
	readonly message: ClineSayTool
}

interface HostedImageGenerationState {
	readonly functionId: string
	readonly previewsBySequence: Map<number, ImageGenerationPresentationV1["preview"] extends infer T ? NonNullable<T> : never>
	prompt: string
	terminal: boolean
}

export interface HostedImageGenerationLifecycleOptions {
	readonly taskId: string
	readonly context: HostedImageGenerationContext
	readonly artifactResolver?: Pick<ArtifactResolver, "persistProviderOutput">
	readonly previewStore?: Pick<TaskImagePreviewStore, "persistPreview" | "clearRequest">
	readonly onUpdate: (update: HostedImageGenerationUpdate) => Promise<void> | void
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textFromUnknown(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined
}

function readResult(result: unknown): { b64Json: string; revisedPrompt?: string } | undefined {
	if (typeof result === "string" && result.length > 0) return { b64Json: result }
	if (!isRecord(result)) return undefined
	const b64Json = textFromUnknown(result.b64Json) ?? textFromUnknown(result.b64_json) ?? textFromUnknown(result.result)
	if (!b64Json) return undefined
	const revisedPrompt = textFromUnknown(result.revisedPrompt) ?? textFromUnknown(result.revised_prompt)
	return { b64Json, ...(revisedPrompt ? { revisedPrompt } : {}) }
}

function readPreviewResult(result: unknown): { base64: string; sequence: number } | undefined {
	if (!isRecord(result)) return undefined
	const base64 = textFromUnknown(result.partialImageB64) ?? textFromUnknown(result.partial_image_b64)
	const sequence = result.sequence
	if (!base64 || typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 0) return undefined
	return { base64, sequence }
}

function promptFromChunk(chunk: ApiStreamServerToolChunk, fallback: string): string {
	for (const value of [chunk.input, chunk.result]) {
		if (!isRecord(value)) continue
		const prompt =
			textFromUnknown(value.prompt) ?? textFromUnknown(value.revisedPrompt) ?? textFromUnknown(value.revised_prompt)
		if (prompt) return prompt
	}
	return fallback
}

function artifactPresentation(artifact: ImageArtifact): ImageGenerationArtifactPresentationV1 {
	return {
		id: artifact.id,
		mimeType: artifact.mimeType,
		format: artifact.format,
		byteLength: artifact.byteLength,
		width: artifact.width,
		height: artifact.height,
		revisedPrompt: artifact.provenance?.revisedPrompt,
	}
}

function createMessage(presentation: ImageGenerationPresentationV1): ClineSayTool {
	return {
		tool: "generateImage",
		content: presentation.prompt,
		imageGeneration: presentation,
		operationIsLocatedInWorkspace: false,
	}
}

/** Owns provider-hosted image generation for one Task request and persists only safe Artifacts. */
export class HostedImageGenerationLifecycle {
	private readonly calls = new Map<string, HostedImageGenerationState>()
	private readonly artifactResolver
	private readonly previewStore

	constructor(private readonly options: HostedImageGenerationLifecycleOptions) {
		this.artifactResolver = options.artifactResolver ?? createTaskArtifactResolver(options.taskId)
		this.previewStore = options.previewStore ?? createTaskImagePreviewStore(options.taskId)
	}

	private accepts(chunk: ApiStreamServerToolChunk): boolean {
		return (
			this.options.context.enabled &&
			chunk.tool === ServerTool.IMAGE_GENERATION &&
			typeof chunk.dline_tid === "string" &&
			chunk.dline_tid.length > 0 &&
			typeof chunk.function_id === "string" &&
			chunk.function_id.length > 0
		)
	}

	private async emit(dlineTid: string, presentation: ImageGenerationPresentationV1, partial: boolean): Promise<void> {
		try {
			await this.options.onUpdate({ dlineTid, partial, message: createMessage(presentation) })
		} catch {
			// UI teardown must not turn a completed Provider request into a second failure.
		}
	}

	private basePresentation(dlineTid: string, prompt: string): ImageGenerationPresentationV1 {
		return {
			schemaVersion: IMAGE_GENERATION_PRESENTATION_SCHEMA_VERSION,
			status: "started",
			requestId: dlineTid,
			prompt,
			providerId: this.options.context.providerId,
			modelId: this.options.context.modelId,
			count: 1,
		}
	}

	async consume(chunk: ApiStreamServerToolChunk): Promise<boolean> {
		if (!this.accepts(chunk)) return false
		const dlineTid = chunk.dline_tid
		const existing = this.calls.get(dlineTid)
		if (existing?.functionId !== undefined && existing.functionId !== chunk.function_id) return false
		if (existing?.terminal) return true

		const state: HostedImageGenerationState = existing ?? {
			functionId: chunk.function_id,
			previewsBySequence: new Map(),
			prompt: this.options.context.prompt?.trim() || "Provider-hosted image generation",
			terminal: false,
		}
		state.prompt = promptFromChunk(chunk, state.prompt)
		this.calls.set(dlineTid, state)

		if (chunk.phase === "failed") {
			state.terminal = true
			await this.previewStore.clearRequest(dlineTid)
			await this.emit(
				dlineTid,
				{
					...this.basePresentation(dlineTid, state.prompt),
					status: "failed",
					error: {
						code: "provider_error",
						message: "OpenAI hosted image generation failed.",
						retryable: false,
					},
				},
				false,
			)
			return true
		}

		if (chunk.phase === "preview") {
			const partial = readPreviewResult(chunk.result)
			if (!partial) return true
			const preview = await this.previewStore.persistPreview(dlineTid, partial.sequence, partial.base64)
			state.previewsBySequence.set(preview.sequence, preview)
			await this.emit(
				dlineTid,
				{
					...this.basePresentation(dlineTid, state.prompt),
					status: "preview",
					previews: [...state.previewsBySequence.values()].sort((left, right) => left.sequence - right.sequence),
				},
				true,
			)
			return true
		}

		if (chunk.phase !== "completed") {
			await this.emit(dlineTid, this.basePresentation(dlineTid, state.prompt), true)
			return true
		}

		try {
			const result = readResult(chunk.result)
			if (!result) throw new Error("Hosted image result is unavailable")
			state.prompt = result.revisedPrompt ?? state.prompt
			const output: ImageProviderOutput = {
				id: chunk.function_id,
				source: { kind: "base64", data: result.b64Json, mimeType: "image/png" },
				revisedPrompt: result.revisedPrompt,
			}
			const artifact = await this.artifactResolver.persistProviderOutput(output, {
				providerId: this.options.context.providerId,
				modelId: this.options.context.modelId,
				requestId: dlineTid,
				...(this.options.context.referenceArtifactIds?.length
					? { parentArtifactIds: [...new Set(this.options.context.referenceArtifactIds)] }
					: {}),
			})
			state.terminal = true
			await this.emit(
				dlineTid,
				{
					...this.basePresentation(dlineTid, state.prompt),
					status: "completed",
					previews: [...state.previewsBySequence.values()].sort((left, right) => left.sequence - right.sequence),
					artifacts: [artifactPresentation(artifact)],
					usage: { imageCount: 1, totalOutputBytes: artifact.byteLength },
				},
				false,
			)
		} catch {
			state.terminal = true
			await this.previewStore.clearRequest(dlineTid)
			await this.emit(
				dlineTid,
				{
					...this.basePresentation(dlineTid, state.prompt),
					status: "failed",
					error: {
						code: "invalid_response",
						message: "OpenAI hosted image output could not be persisted.",
						retryable: false,
					},
				},
				false,
			)
		}
		return true
	}

	async finalizeOpen(): Promise<void> {
		for (const [dlineTid, state] of this.calls) {
			if (state.terminal) continue
			state.terminal = true
			await this.previewStore.clearRequest(dlineTid)
			await this.emit(
				dlineTid,
				{
					...this.basePresentation(dlineTid, state.prompt),
					status: "failed",
					error: {
						code: "provider_error",
						message: "Provider stream ended before hosted image generation completed.",
						retryable: true,
					},
				},
				false,
			)
		}
	}
}
