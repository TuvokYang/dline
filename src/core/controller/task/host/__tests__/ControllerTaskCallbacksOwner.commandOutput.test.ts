import { registerPartialMessageCallback } from "@core/controller/ui/subscribeToPartialMessage"
import type { MessageStateHandler } from "@core/task/message-state"
import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { ControllerTaskCallbacksOwner } from "../ControllerTaskCallbacksOwner"

/**
 * A command_output row is merged into its command row by commandTs alone, so the
 * host say adapter has to carry that key all the way into the persisted message.
 * Losing it renders the command with no output at all.
 */
function messageStore(): { handler: MessageStateHandler; written: UiMessage[] } {
	const written: UiMessage[] = []
	const handler = {
		get clineMessages() {
			return written
		},
		addToClineMessages: async (message: UiMessage) => {
			written.push(message)
		},
		upsertClineMessageInMemory: async (message: UiMessage) => {
			written.push(message)
			return message
		},
		finalizeClineMessage: async (message: UiMessage) => {
			written.push(message)
		},
	} as unknown as MessageStateHandler
	return { handler, written }
}

function owner(messages: MessageStateHandler): ControllerTaskCallbacksOwner {
	return new ControllerTaskCallbacksOwner({
		controller: {} as never,
		taskId: "task-1",
		stateManager: {
			getGlobalSettingsKey: () => ({ enabled: false, remindClineInterval: 6 }),
			getGlobalStateKey: () => undefined,
		} as never,
		messages,
		interactions: {} as never,
		api: {} as never,
		toolState: {} as never,
		createBrowser: () => ({}) as never,
	})
}

describe("ControllerTaskCallbacksOwner say", () => {
	it("carries commandTs onto the persisted command_output row", async () => {
		const { handler, written } = messageStore()

		await owner(handler).callbacks.say("command_output", "line-1", undefined, undefined, false, undefined, 4242)

		expect(written).toHaveLength(1)
		expect(written[0]).toMatchObject({ say: "command_output", text: "line-1", commandTs: 4242 })
	})

	it("leaves commandTs unset for rows that do not belong to a command", async () => {
		const { handler, written } = messageStore()

		await owner(handler).callbacks.say("text", "hello")

		expect(written).toHaveLength(1)
		expect(written[0].commandTs).toBeUndefined()
	})

	it("finalizes a command row as pending so its execution can mark it running", async () => {
		const { handler, written } = messageStore()
		written.push({ ts: 77, type: "say", say: "command", text: "npm test", partial: true })

		await owner(handler).callbacks.say("command", "npm test", undefined, undefined, false, 77)

		expect(written.at(-1)).toMatchObject({ ts: 77, say: "command", partial: false, commandStatus: "pending" })
	})

	it("keeps the status a command row already reached when it is finalized again", async () => {
		const { handler, written } = messageStore()
		written.push({ ts: 78, type: "say", say: "command", text: "npm test", commandStatus: "running" })

		await owner(handler).callbacks.say("command", "npm test", undefined, undefined, false, 78)

		expect(written.at(-1)).toMatchObject({ ts: 78, commandStatus: "running" })
	})

	it("publishes a finalized row after replacing its in-memory partial", async () => {
		const { handler, written } = messageStore()
		written.push({ ts: 99, type: "ask", ask: "tool", text: "awaiting", partial: true })
		const delivered: Array<{ ts: number; text: string; partial: boolean }> = []
		const unsubscribe = registerPartialMessageCallback((message) => {
			delivered.push({ ts: Number(message.ts), text: message.text, partial: message.partial })
		})

		try {
			await owner(handler).callbacks.say("tool", "rejected", undefined, undefined, false, 99)
		} finally {
			unsubscribe()
		}

		expect(written).toContainEqual(expect.objectContaining({ ts: 99, type: "say", text: "rejected", partial: false }))
		expect(delivered).toEqual([{ ts: 99, text: "rejected", partial: false }])
	})

	it("publishes a partial row after updating the in-memory message", async () => {
		const { handler, written } = messageStore()
		const delivered: Array<{ ts: number; text: string; partial: boolean }> = []
		const unsubscribe = registerPartialMessageCallback((message) => {
			delivered.push({ ts: Number(message.ts), text: message.text, partial: message.partial })
		})

		try {
			await owner(handler).callbacks.say("tool", "preview", undefined, undefined, true, 99)
		} finally {
			unsubscribe()
		}

		expect(written).toContainEqual(expect.objectContaining({ ts: 99, text: "preview", partial: true }))
		expect(delivered).toEqual([{ ts: 99, text: "preview", partial: true }])
	})
})
