import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ClineMessage } from "@/shared/ExtensionMessage"
import type { ClineStorageMessage } from "@/shared/messages/content"

const mocks = vi.hoisted(() => ({
	access: vi.fn(),
	copyFile: vi.fn(),
	readFile: vi.fn(),
	ensureTaskDirectoryExists: vi.fn(),
	getSavedApiConversationHistory: vi.fn(),
	saveClineMessages: vi.fn(),
}))

vi.mock("fs/promises", () => ({
	default: {
		access: mocks.access,
		copyFile: mocks.copyFile,
		readFile: mocks.readFile,
	},
}))

vi.mock("@core/storage/disk", () => ({
	ensureTaskDirectoryExists: mocks.ensureTaskDirectoryExists,
	GlobalFileNames: { uiMessages: "ui_messages.jsonl" },
	getSavedApiConversationHistory: mocks.getSavedApiConversationHistory,
	saveClineMessages: mocks.saveClineMessages,
}))

import { recoverUiMessages } from "../recoverUiMessages"

function recoveredHistory(): ClineStorageMessage[] {
	return [
		{
			role: "user",
			content: [{ type: "text", text: "<task>Restore the interaction</task>" }],
		},
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					function_id: "call-qna-1",
					dline_tid: "interaction-qna-1",
					name: "qna_respond",
					input: { response: "Recovered answer" },
				},
			],
		},
	]
}

describe("recoverUiMessages", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		mocks.ensureTaskDirectoryExists.mockResolvedValue("e:\\workspace\\task-1")
		mocks.getSavedApiConversationHistory.mockResolvedValue(recoveredHistory())
		mocks.access.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))
		mocks.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))
		mocks.saveClineMessages.mockResolvedValue(undefined)
	})

	it("preserves canonical interaction identity without starting an interactive resume", async () => {
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const session = createSessionFixture({ taskId: "task-1" })
		const controller = { task: session, postStateToWebview }

		await recoverUiMessages(controller as never)

		const savedMessages = mocks.saveClineMessages.mock.calls[0]?.[1] as ClineMessage[] | undefined
		const recoveredAsk = savedMessages?.find((message) => message.type === "ask" && message.ask === "qna_respond")
		expect(recoveredAsk).toMatchObject({
			type: "ask",
			ask: "qna_respond",
			interactionId: "interaction-qna-1",
		})
		// Recovery re-reads the durable store; it must not drive the task facade.
		expect(session.owners.messages.reloadFromStore).toHaveBeenCalledOnce()
		expect(session.task.start).not.toHaveBeenCalled()
		expect(session.task.respond).not.toHaveBeenCalled()
		expect(session.task.submitInput).not.toHaveBeenCalled()
		expect(postStateToWebview).toHaveBeenCalledOnce()
	})

	it("preserves the selected mode in a recovered spawn task approval", async () => {
		mocks.getSavedApiConversationHistory.mockResolvedValue([
			{
				role: "user",
				content: [{ type: "text", text: "<task>Spawn implementation work</task>" }],
			},
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						function_id: "call-spawn-1",
						dline_tid: "interaction-spawn-1",
						name: "spawn_task",
						input: { task: "Implement feature", mode: "act", context: "Use the existing architecture" },
					},
				],
			},
		])
		const controller = {
			task: createSessionFixture({ taskId: "task-1" }),
			postStateToWebview: vi.fn().mockResolvedValue(undefined),
		}

		await recoverUiMessages(controller as never)

		const savedMessages = mocks.saveClineMessages.mock.calls[0]?.[1] as ClineMessage[] | undefined
		const recoveredAsk = savedMessages?.find((message) => message.type === "ask" && message.ask === "spawn_task")
		expect(JSON.parse(recoveredAsk?.text ?? "{}")).toEqual({
			task: "Implement feature",
			mode: "act",
			context: "Use the existing architecture",
		})
	})
})
