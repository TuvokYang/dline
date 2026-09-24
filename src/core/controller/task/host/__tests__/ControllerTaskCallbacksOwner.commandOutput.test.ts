import type { MessageStateHandler } from "@core/task/message-state"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { ControllerTaskCallbacksOwner } from "../ControllerTaskCallbacksOwner"

/**
 * A command_output row is merged into its command row by commandTs alone, so the
 * host say adapter has to carry that key all the way into the persisted message.
 * Losing it renders the command with no output at all.
 */
function messageStore(): { handler: MessageStateHandler; written: ClineMessage[] } {
	const written: ClineMessage[] = []
	const handler = {
		get clineMessages() {
			return written
		},
		addToClineMessages: async (message: ClineMessage) => {
			written.push(message)
		},
		upsertClineMessageInMemory: async (message: ClineMessage) => {
			written.push(message)
			return message
		},
		finalizeClineMessage: async (message: ClineMessage) => {
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
})
