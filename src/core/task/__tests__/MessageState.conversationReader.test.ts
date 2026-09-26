import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import type { ApiConversation } from "../../storage/ApiConversation"
import type { ConversationHistoryReader } from "../conversation/ConversationHistoryReader"
import { MessageStateHandler } from "../message-state"

function message(role: "user" | "assistant", text: string): ClineStorageMessage {
	return { role, content: [{ type: "text", text }], ts: 1 }
}

/** A legacy store as a task written before the journal existed left it. */
function legacyStore(messages: ClineStorageMessage[]): ApiConversation {
	return { getAll: () => messages, count: messages.length } as unknown as ApiConversation
}

function journal(messages: ClineStorageMessage[]): ConversationHistoryReader {
	let size = 0
	return {
		read: async () => {
			size = messages.length
			return messages
		},
		count: async () => {
			size = messages.length
			return size
		},
		size: () => size,
		position: () => messages.length,
	}
}

function handler(options: { conversation?: ConversationHistoryReader; legacy?: ClineStorageMessage[] }) {
	return new MessageStateHandler({
		taskId: "task-reader",
		ulid: "ulid",
		updateTaskHistory: async () => [],
		...(options.conversation ? { conversation: options.conversation } : {}),
		...(options.legacy ? { apiConversation: legacyStore(options.legacy) } : {}),
	})
}

describe("MessageStateHandler conversation reader", () => {
	it("reads the journal conversation, not the legacy file the runtime no longer writes", async () => {
		const state = handler({
			conversation: journal([message("user", "from journal"), message("assistant", "reply")]),
			legacy: [message("user", "stale legacy")],
		})

		const history = await state.readConversationHistory()

		expect(history.map((item) => (item.content as { text: string }[])[0]?.text)).toEqual(["from journal", "reply"])
	})

	it("falls back to the legacy file for a task whose journal is empty", async () => {
		const state = handler({ conversation: journal([]), legacy: [message("user", "legacy task")] })

		const history = await state.readConversationHistory()

		expect(history).toHaveLength(1)
		expect(state.conversationSize()).toBe(1)
	})

	it("positions chat rows against the journal once it has been read", async () => {
		const state = handler({
			conversation: journal([message("user", "a"), message("assistant", "b"), message("user", "c")]),
			legacy: [message("user", "legacy")],
		})

		await state.readConversationHistory()

		expect(state.conversationSize()).toBe(3)
	})

	it("reads nothing when the task has neither", async () => {
		const state = handler({})

		expect(await state.readConversationHistory()).toEqual([])
		expect(state.conversationSize()).toBe(0)
	})
})
