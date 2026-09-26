import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ClineMessage } from "@/shared/ExtensionMessage"
import type { ClineStorageMessage } from "@/shared/messages/content"

const mocks = vi.hoisted(() => ({
	readFile: vi.fn(),
	ensureTaskDirectoryExists: vi.fn(),
	getSavedApiConversationHistory: vi.fn(),
	getSavedClineMessages: vi.fn(),
	writeJsonAtomic: vi.fn(),
	openUiMessage: vi.fn(),
}))

vi.mock("fs/promises", () => ({
	default: {
		readFile: mocks.readFile,
	},
}))

vi.mock("@core/storage/disk", () => ({
	ensureTaskDirectoryExists: mocks.ensureTaskDirectoryExists,
	getSavedClineMessages: mocks.getSavedClineMessages,
}))

// The conversation now comes from the task's journal; the mock stands in for either source.
vi.mock("@core/task/conversation/TaskConversationReader", () => ({
	readTaskConversation: mocks.getSavedApiConversationHistory,
}))

vi.mock("@/shared/storage/atomic-file", () => ({
	writeJsonAtomic: mocks.writeJsonAtomic,
}))

vi.mock("@core/storage/UIMessage", () => ({
	UIMessage: { open: mocks.openUiMessage },
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
		mocks.getSavedClineMessages.mockResolvedValue([])
		mocks.readFile.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }))
		mocks.writeJsonAtomic.mockResolvedValue(undefined)
	})

	it("replaces an open task's history through that task's own writer", async () => {
		const postStateToWebview = vi.fn().mockResolvedValue(undefined)
		const session = createSessionFixture({ taskId: "task-1" })
		const controller = { task: session, postStateToWebview }

		await recoverUiMessages(controller as never)

		const replace = session.owners.messages.replaceClineMessages
		expect(replace).toHaveBeenCalledOnce()
		const savedMessages = replace.mock.calls[0]?.[0] as ClineMessage[] | undefined
		const recoveredAsk = savedMessages?.find((message) => message.type === "ask" && message.ask === "qna_respond")
		expect(recoveredAsk).toMatchObject({
			type: "ask",
			ask: "qna_respond",
			interactionId: "interaction-qna-1",
		})
		// A second writer on messages.db would conflict with the open task's writer.
		expect(mocks.openUiMessage).not.toHaveBeenCalled()
		expect(session.task.start).not.toHaveBeenCalled()
		expect(session.task.respond).not.toHaveBeenCalled()
		expect(session.task.submitInput).not.toHaveBeenCalled()
		expect(postStateToWebview).toHaveBeenCalledOnce()
	})

	it("opens a closed task's store only for the write and backs up the previous history", async () => {
		const previous = [{ ts: 1, type: "say", say: "task", text: "old" }] as ClineMessage[]
		mocks.getSavedClineMessages.mockResolvedValue(previous)
		const store = { overwrite: vi.fn(async () => undefined), close: vi.fn(async () => undefined) }
		mocks.openUiMessage.mockResolvedValue(store)

		await recoverUiMessages(undefined, "task-1")

		expect(mocks.writeJsonAtomic).toHaveBeenCalledOnce()
		expect(mocks.writeJsonAtomic.mock.calls[0]?.[1]).toEqual(previous)
		expect(mocks.openUiMessage).toHaveBeenCalledWith("task-1")
		expect(store.overwrite).toHaveBeenCalledOnce()
		expect(store.close).toHaveBeenCalledOnce()
	})

	it("closes the temporary store even when the write fails", async () => {
		const store = {
			overwrite: vi.fn(async () => {
				throw new Error("disk full")
			}),
			close: vi.fn(async () => undefined),
		}
		mocks.openUiMessage.mockResolvedValue(store)

		await expect(recoverUiMessages(undefined, "task-1")).rejects.toThrow("disk full")
		expect(store.close).toHaveBeenCalledOnce()
		expect(mocks.writeJsonAtomic).not.toHaveBeenCalled()
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

		const savedMessages = controller.task.owners.messages.replaceClineMessages.mock.calls[0]?.[0] as
			| ClineMessage[]
			| undefined
		const recoveredAsk = savedMessages?.find((message) => message.type === "ask" && message.ask === "spawn_task")
		expect(JSON.parse(recoveredAsk?.text ?? "{}")).toEqual({
			task: "Implement feature",
			mode: "act",
			context: "Use the existing architecture",
		})
	})
})
