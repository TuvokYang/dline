import { ApiConversation } from "@core/storage/ApiConversation"
import { UIMessage } from "@core/storage/UIMessage"
import { serializeDurableToolResult } from "@core/task/DurableToolResult"
import type { ClineStorageMessage, ClineUserToolResultContentBlock } from "@shared/messages"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

const ARTIFACT_ID = `image:sha256:${"e".repeat(64)}`
const PROVIDER_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"

function safeToolResult(): ClineUserToolResultContentBlock {
	return {
		type: "tool_result",
		function_id: "image-function-1",
		dline_tid: "image-request-1",
		content: JSON.stringify({
			requestId: "image-request-1",
			providerId: "openai",
			modelId: "gpt-image-2",
			artifacts: [{ id: ARTIFACT_ID, mimeType: "image/png", width: 1024, height: 1024 }],
		}),
	}
}

describe("image generation persistence boundaries", () => {
	let documentsDirectory: string
	let originalDocumentsDirectory: string | undefined

	beforeEach(async () => {
		originalDocumentsDirectory = process.env.DLINE_DOCS_DIR
		documentsDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-image-persistence-"))
		process.env.DLINE_DOCS_DIR = documentsDirectory
	})

	afterEach(async () => {
		if (originalDocumentsDirectory === undefined) delete process.env.DLINE_DOCS_DIR
		else process.env.DLINE_DOCS_DIR = originalDocumentsDirectory
		await fs.rm(documentsDirectory, { recursive: true, force: true })
	})

	it("persists only artifact metadata in UI, API, and durable tool result history", async () => {
		const taskId = "task-image-persistence"
		const toolResult = safeToolResult()
		const presentation = {
			schemaVersion: 1 as const,
			status: "completed" as const,
			requestId: "image-request-1",
			prompt: "A blue owl",
			profileId: "profile-1",
			providerId: "openai",
			modelId: "gpt-image-2",
			count: 1,
			artifacts: [
				{ id: ARTIFACT_ID, mimeType: "image/png", format: "png" as const, byteLength: 64, width: 1024, height: 1024 },
			],
		}
		const ui = await UIMessage.open(taskId)
		await ui.addMessage({
			ts: 1,
			type: "say",
			say: "tool",
			text: JSON.stringify({ tool: "generateImage", content: "A blue owl", imageGeneration: presentation }),
			imageGeneration: presentation,
		})
		await ui.addMessage({ ts: 2, type: "say", say: "partial_tool_result", text: serializeDurableToolResult(toolResult) })
		await ui.flush()

		const api = await ApiConversation.open(taskId)
		const apiMessage: ClineStorageMessage = { role: "user", content: [toolResult], ts: 3 }
		await api.addMessage(apiMessage)
		await api.flush()

		const taskDirectory = path.join(documentsDirectory, "tasks", taskId)
		const persisted = [
			await fs.readFile(path.join(taskDirectory, "ui_messages.jsonl"), "utf8"),
			await fs.readFile(path.join(taskDirectory, "api_conversation_history.jsonl"), "utf8"),
			serializeDurableToolResult(toolResult),
		].join("\n")

		expect(persisted).toContain(ARTIFACT_ID)
		expect(persisted).not.toContain(PROVIDER_BASE64)
		expect(persisted).not.toContain("data:image")
		expect(persisted).not.toMatch(/"(?:b64_json|base64|data)"\s*:/)
	})
})
