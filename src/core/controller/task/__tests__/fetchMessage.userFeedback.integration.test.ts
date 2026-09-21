import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { FetchMessageRequest } from "@shared/proto/dline/task"
import { convertProtoToClineMessage } from "@shared/proto-conversions/cline-message"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { UIMessage } from "../../../storage/UIMessage"
import { MessageChannel } from "../../../task/MessageChannel"
import { MessageStateHandler } from "../../../task/message-state"
import { TaskState } from "../../../task/TaskState"
import { fetchMessage } from "../fetchMessage"

describe("fetchMessage durable user_feedback integration", () => {
	let docsDir: string
	let previousDocsDir: string | undefined

	beforeEach(async () => {
		previousDocsDir = process.env.DLINE_DOCS_DIR
		docsDir = await mkdtemp(path.join(os.tmpdir(), "dline-user-feedback-"))
		process.env.DLINE_DOCS_DIR = docsDir
	})

	afterEach(async () => {
		if (previousDocsDir === undefined) {
			delete process.env.DLINE_DOCS_DIR
		} else {
			process.env.DLINE_DOCS_DIR = previousDocsDir
		}
		await rm(docsDir, { force: true, recursive: true })
	})

	it("persists final user_feedback and returns it through the fetchMessage RPC boundary", async () => {
		const taskId = "task-user-feedback"
		const taskState = new TaskState()
		const uiMessage = await UIMessage.open(taskId)
		const messageStateHandler = new MessageStateHandler({
			taskId,
			ulid: "ulid-user-feedback",
			taskState,
			uiMessage,
			updateTaskHistory: async () => [],
		})
		let timestamp = 100
		const channel = new MessageChannel({
			pushMessage: () => {},
			syncState: async () => {},
			messageStateHandler,
			taskState,
			getProviderInfo: () => ({ providerId: "test", modelId: "test-model", mode: "act" }),
			genTs: () => ++timestamp,
		})

		await channel.say("user_feedback", "durable feedback")
		await uiMessage.flush()

		const reopened = await UIMessage.open(taskId)
		const persistedMessages = [...reopened.getAll()]
		const response = await fetchMessage(
			{
				fetchCurrentTaskMessages: async (referenceIndex: number, count: number) => {
					const startIndex = referenceIndex === -1 ? Math.max(0, persistedMessages.length - count) : referenceIndex
					return {
						messages: persistedMessages.slice(startIndex, startIndex + count),
						totalCount: persistedMessages.length,
						startIndex,
					}
				},
			} as never,
			FetchMessageRequest.create({ referenceIndex: -1, count: 20 }),
		)
		const messages = response.messages.map(convertProtoToClineMessage)

		expect(reopened.count).toBe(1)
		expect(messages).toContainEqual(expect.objectContaining({ say: "user_feedback", text: "durable feedback" }))
		expect(messages.find((message) => message.say === "user_feedback")?.partial).not.toBe(true)
	})
})
