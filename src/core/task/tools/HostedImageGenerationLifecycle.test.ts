import type { ApiStreamServerToolChunk } from "@core/api/transform/stream"
import type { ImageArtifact } from "@core/artifacts/TaskArtifactStore"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it, vi } from "vitest"
import { HostedImageGenerationLifecycle } from "./HostedImageGenerationLifecycle"

const parentArtifactId = `image:sha256:${"b".repeat(64)}`

const artifact: ImageArtifact = {
	schemaVersion: 1,
	id: `image:sha256:${"a".repeat(64)}`,
	kind: "image",
	sha256: "a".repeat(64),
	mimeType: "image/png",
	format: "png",
	byteLength: 68,
	width: 1,
	height: 1,
	relativePath: "artifacts/images/test.png",
	createdAtMs: 1,
	provenance: {
		providerId: "openai",
		modelId: "gpt-5.6-sol",
		requestId: "tid-image",
		revisedPrompt: "A blue owl",
		sourceKind: "base64",
	},
}

function chunk(phase: ApiStreamServerToolChunk["phase"], result?: unknown): ApiStreamServerToolChunk {
	return {
		type: "server_tool",
		function_id: "ig_1",
		dline_tid: "tid-image",
		tool: ServerTool.IMAGE_GENERATION,
		phase,
		...(result === undefined ? {} : { result }),
	}
}

describe("HostedImageGenerationLifecycle", () => {
	it("persists the final base64 and emits only Artifact metadata", async () => {
		const persistProviderOutput = vi.fn(async () => artifact)
		const updates: unknown[] = []
		const lifecycle = new HostedImageGenerationLifecycle({
			taskId: "task-1",
			context: { enabled: true, providerId: "openai", modelId: "gpt-5.6-sol", referenceArtifactIds: [parentArtifactId] },
			artifactResolver: { persistProviderOutput },
			onUpdate: (update) => {
				updates.push(update)
			},
		})

		await lifecycle.consume(chunk("started"))
		await lifecycle.consume(chunk("completed", { b64Json: "secret-image-base64", revisedPrompt: "A blue owl" }))

		expect(persistProviderOutput).toHaveBeenCalledWith(
			expect.objectContaining({ source: { kind: "base64", data: "secret-image-base64", mimeType: "image/png" } }),
			{
				providerId: "openai",
				modelId: "gpt-5.6-sol",
				requestId: "tid-image",
				parentArtifactIds: [parentArtifactId],
			},
		)
		const serialized = JSON.stringify(updates)
		expect(serialized).not.toContain("secret-image-base64")
		expect(updates.at(-1)).toMatchObject({
			partial: false,
			message: {
				tool: "generateImage",
				imageGeneration: {
					status: "completed",
					requestId: "tid-image",
					artifacts: [{ id: artifact.id, mimeType: "image/png", width: 1, height: 1 }],
				},
			},
		})
	})

	it("keeps the initial prompt and all partial handles ordered through completion", async () => {
		const persistPreview = vi.fn(async (_requestId: string, sequence: number) => ({
			id: `image-preview:sha256:${String(sequence).repeat(64)}`,
			mimeType: "image/png" as const,
			width: 512,
			height: 288,
			sequence,
		}))
		const clearRequest = vi.fn(async () => undefined)
		const updates: any[] = []
		const lifecycle = new HostedImageGenerationLifecycle({
			taskId: "task-1",
			context: {
				enabled: true,
				providerId: "openai",
				modelId: "gpt-5.6-sol",
				referenceArtifactIds: [],
				prompt: "A blue owl before pixels arrive",
			},
			artifactResolver: { persistProviderOutput: vi.fn(async () => artifact) },
			previewStore: { persistPreview, clearRequest },
			onUpdate: (update) => {
				updates.push(update)
			},
		})

		await lifecycle.consume(chunk("started"))
		expect(updates.at(-1)).toMatchObject({
			message: { imageGeneration: { status: "started", prompt: "A blue owl before pixels arrive" } },
		})
		for (const sequence of [2, 0, 1]) {
			await lifecycle.consume(chunk("preview", { partialImageB64: `secret-preview-${sequence}`, sequence }))
		}
		await lifecycle.consume(chunk("completed", { b64Json: "secret-final", revisedPrompt: "A revised blue owl" }))

		expect(persistPreview.mock.calls.map((call) => call[1])).toEqual([2, 0, 1])
		expect(updates.at(-2).message.imageGeneration.previews.map((preview: { sequence: number }) => preview.sequence)).toEqual([
			0, 1, 2,
		])
		expect(updates.at(-1)).toMatchObject({
			partial: false,
			message: {
				imageGeneration: {
					status: "completed",
					previews: [{ sequence: 0 }, { sequence: 1 }, { sequence: 2 }],
					artifacts: [{ id: artifact.id }],
				},
			},
		})
		expect(clearRequest).not.toHaveBeenCalled()
		expect(JSON.stringify(updates)).not.toContain("secret-preview")
		expect(JSON.stringify(updates)).not.toContain("secret-final")
	})

	it("rejects image chunks when the hosted route is disabled", async () => {
		const lifecycle = new HostedImageGenerationLifecycle({
			taskId: "task-1",
			context: { enabled: false, providerId: "openai", modelId: "gpt-5.6-sol", referenceArtifactIds: [] },
			artifactResolver: { persistProviderOutput: vi.fn() },
			onUpdate: vi.fn(),
		})

		expect(await lifecycle.consume(chunk("completed", { b64Json: "ignored" }))).toBe(false)
	})
})
