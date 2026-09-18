import { resolveTaskArtifactPath } from "@core/artifacts/runtime"
import type { ImageArtifact } from "@core/artifacts/TaskArtifactStore"
import type { ToolUse } from "@core/assistant-message"
import { ImageGenerationError } from "@core/image-generation/contracts"
import { ClineDefaultTool } from "@shared/tools"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { TaskConfig } from "../../types/TaskConfig"
import { GenerateImageToolHandler } from "../GenerateImageToolHandler"

const artifact: ImageArtifact = {
	schemaVersion: 1,
	id: `image:sha256:${"b".repeat(64)}`,
	kind: "image",
	sha256: "b".repeat(64),
	mimeType: "image/png",
	format: "png",
	byteLength: 64,
	width: 1024,
	height: 1024,
	relativePath: `images/${"b".repeat(64)}.png`,
	createdAtMs: 1,
}

const block: ToolUse = {
	type: "tool_use",
	name: ClineDefaultTool.GENERATE_IMAGE,
	params: {
		prompt: "A blue owl",
		profile: "OpenAI Images",
		count: "2",
		width: "1024",
		height: "1024",
		background: "transparent",
		output_format: "png",
		reference_artifact_ids: JSON.stringify([`image:sha256:${"c".repeat(64)}`]),
		mask_artifact_id: `image:sha256:${"d".repeat(64)}`,
	},
	partial: false,
	ts: 42,
	function_id: "image-function-1",
	dline_tid: "image-request-1",
}

function createConfig(autoApprove: boolean) {
	const say = vi.fn<TaskConfig["callbacks"]["say"]>(async () => undefined)
	const operationController = new AbortController()
	const generate = vi.fn(
		async (_request?: unknown, _context?: { signal: AbortSignal; onProgress?: (event: unknown) => Promise<void> }) => ({
			requestId: "image-request-1",
			profileId: "profile-1",
			providerId: "openai",
			modelId: "gpt-image-2",
			artifacts: [artifact],
			usage: { imageCount: 1, totalOutputBytes: 64 },
		}),
	)
	const resolveProfile = vi.fn(() => ({
		profile: { id: "profile-1", provider: "openai", imageModelId: "gpt-image-2" },
		model: { id: "gpt-image-2", capabilities: { supportsGeneration: true } },
	}))
	const config = {
		taskId: "task-1",
		ulid: "ulid-1",
		cwd: "e:/workspace/vscode/dline",
		mode: "act",
		isSubagentExecution: false,
		autoApprovalSettings: { actions: { generateImages: autoApprove }, enableNotifications: false },
		taskState: { consecutiveMistakeCount: 0, operationSignal: operationController.signal },
		api: { getModel: () => ({ id: "chat-model" }) },
		services: { imageGenerationService: { resolveProfile, generate } },
		callbacks: {
			say,
			ask: vi.fn(async () => ({ response: "yesButtonClicked" })),
			sayAndCreateMissingParamError: vi.fn(async () => "missing"),
		},
	} as unknown as TaskConfig
	return { config, generate, operationController, resolveProfile, say }
}

describe("GenerateImageToolHandler", () => {
	beforeEach(() => vi.clearAllMocks())

	it("strictly parses provider-neutral parameters and returns only safe artifact metadata", async () => {
		const { config, generate, resolveProfile, say } = createConfig(true)

		const result = await new GenerateImageToolHandler().execute(config, block)

		expect(resolveProfile).toHaveBeenCalledWith("OpenAI Images")
		expect(generate).toHaveBeenCalledWith(
			expect.objectContaining({
				requestId: "image-request-1",
				profileId: "profile-1",
				providerId: "openai",
				modelId: "gpt-image-2",
				operation: "edit",
				prompt: "A blue owl",
				count: 2,
				size: { width: 1024, height: 1024 },
				background: "transparent",
				outputFormat: "png",
				references: [
					{ artifactId: `image:sha256:${"c".repeat(64)}`, role: "reference" },
					{ artifactId: `image:sha256:${"d".repeat(64)}`, role: "mask" },
				],
			}),
			expect.objectContaining({ signal: config.taskState.operationSignal }),
		)
		expect(typeof result).toBe("string")
		const resultPayload = JSON.parse(result as string)
		expect(resultPayload.artifacts).toEqual([
			expect.objectContaining({
				id: artifact.id,
				path: resolveTaskArtifactPath(config.taskId, artifact.relativePath),
			}),
		])
		expect(resultPayload.reference_artifact_ids).toEqual([artifact.id])
		expect(JSON.stringify(resultPayload)).not.toContain("base64")

		const completedMessage = JSON.parse(say.mock.calls.at(-1)?.[1] as string)
		expect(completedMessage).toMatchObject({
			tool: "generateImage",
			imageGeneration: {
				schemaVersion: 1,
				status: "completed",
				requestId: "image-request-1",
				prompt: "A blue owl",
				profileId: "profile-1",
				providerId: "openai",
				modelId: "gpt-image-2",
				artifacts: [
					{
						id: artifact.id,
						mimeType: "image/png",
						width: 1024,
						height: 1024,
					},
				],
			},
		})
		expect(say.mock.calls.at(-1)?.[5]).toBe(block.ts)
		expect(JSON.stringify(completedMessage)).not.toContain("base64")
	})

	it("publishes preview state without exposing raw provider payloads", async () => {
		const { config, generate, say } = createConfig(true)
		generate.mockImplementationOnce(async (_request, context) => {
			for (const sequence of [2, 0, 1]) {
				await context?.onProgress?.({
					type: "preview",
					requestId: "image-request-1",
					timestampMs: 10 + sequence,
					preview: {
						id: `image-preview:sha256:${String(sequence).repeat(64)}`,
						mimeType: "image/png",
						width: 512,
						height: 288,
						sequence,
					},
				})
			}
			return {
				requestId: "image-request-1",
				profileId: "profile-1",
				providerId: "openai",
				modelId: "gpt-image-2",
				artifacts: [artifact],
				usage: { imageCount: 1, totalOutputBytes: 64 },
			}
		})

		await new GenerateImageToolHandler().execute(config, block)

		const previewMessage = say.mock.calls
			.map((call) => JSON.parse(call[1] as string))
			.find((message) => message.imageGeneration?.status === "preview")
		expect(previewMessage.imageGeneration).toMatchObject({ status: "preview", requestId: "image-request-1" })
		const completedMessage = JSON.parse(say.mock.calls.at(-1)?.[1] as string)
		expect(completedMessage.imageGeneration.previews.map((preview: { sequence: number }) => preview.sequence)).toEqual([
			0, 1, 2,
		])
		expect(JSON.stringify(previewMessage)).not.toContain("base64")
		expect(JSON.stringify(previewMessage)).not.toContain("data:")
	})

	it("aborts an in-flight provider request when the task operation is cancelled", async () => {
		const { config, generate, operationController, say } = createConfig(true)
		let notifyStarted: (() => void) | undefined
		const started = new Promise<void>((resolve) => {
			notifyStarted = resolve
		})
		let providerSignal: AbortSignal | undefined
		generate.mockImplementationOnce(async (_request, context) => {
			providerSignal = context?.signal
			notifyStarted?.()
			await new Promise<void>((resolve) => context?.signal.addEventListener("abort", () => resolve(), { once: true }))
			throw new ImageGenerationError({
				code: "cancelled",
				message: "Image generation was cancelled.",
				retryable: false,
			})
		})
		const execution = new GenerateImageToolHandler().execute(config, block)
		await started
		operationController.abort("task_cancelled")
		await execution

		expect(providerSignal?.aborted).toBe(true)
		const cancelledMessage = JSON.parse(say.mock.calls.at(-1)?.[1] as string)
		expect(cancelledMessage.imageGeneration).toMatchObject({ status: "cancelled", requestId: "image-request-1" })
	})

	it("redacts unknown provider failures before publishing them", async () => {
		const { config, generate, say } = createConfig(true)
		generate.mockRejectedValueOnce(new Error("Provider rejected Authorization: Bearer sk-secret-value"))

		const result = await new GenerateImageToolHandler().execute(config, block)

		const failedMessage = JSON.parse(say.mock.calls.at(-1)?.[1] as string)
		expect(failedMessage).toMatchObject({
			tool: "generateImage",
			imageGeneration: {
				schemaVersion: 1,
				status: "failed",
				requestId: "image-request-1",
				error: { message: "Image generation failed.", code: "provider_error" },
			},
		})
		expect(JSON.stringify(failedMessage)).not.toContain("sk-secret-value")
		expect(JSON.stringify(result)).not.toContain("sk-secret-value")
		expect(say.mock.calls.at(-1)?.[5]).toBe(block.ts)
	})
})
