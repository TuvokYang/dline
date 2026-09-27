import type { UiMessage } from "@shared/ExtensionMessage"
import { beforeEach, describe, expect, it } from "vitest"
import { MessageChannel } from "../MessageChannel"
import { TaskState } from "../TaskState"

/**
 * The receive window must be open before an ask becomes visible.
 *
 * A user can answer as soon as the question reaches the screen. Opening the
 * window afterwards leaves a gap in which the answer is refused and lost, and
 * the ask then waits for a response that is never sent again.
 */

interface Harness {
	channel: MessageChannel
	taskState: TaskState
	messages: UiMessage[]
	/** Receive-window state observed at each point the ask became visible. */
	windowOpenAtVisibility: boolean[]
}

/**
 * Build a MessageChannel whose visibility side effects record whether the
 * receive window was already open when they ran.
 */
function createHarness(): Harness {
	const taskState = new TaskState()
	const messages: UiMessage[] = []
	const windowOpenAtVisibility: boolean[] = []
	let nextTs = 1000

	const isWindowOpen = () => Reflect.get(channel, "isAwaitingAskResponse") === true

	const messageStateHandler = {
		clineMessages: messages,
		addToClineMessages: async (message: UiMessage) => {
			messages.push(message)
		},
		upsertClineMessageInMemory: async (message: UiMessage) => {
			messages.push(message)
			return message
		},
		finalizeClineMessage: async (message: UiMessage) => {
			messages.push(message)
			return message
		},
		updateClineMessage: async () => undefined,
		flushUiMessages: async () => undefined,
	}

	const channel = new MessageChannel({
		pushMessage: () => {
			windowOpenAtVisibility.push(isWindowOpen())
		},
		syncState: async () => {
			windowOpenAtVisibility.push(isWindowOpen())
		},
		messageStateHandler: messageStateHandler as never,
		taskState,
		getProviderInfo: () => ({}) as never,
		genTs: () => nextTs++,
	})

	return { channel, taskState, messages, windowOpenAtVisibility }
}

describe("MessageChannel ask receive window ordering", () => {
	let harness: Harness

	beforeEach(() => {
		harness = createHarness()
	})

	it("opens the receive window before a non-partial ask becomes visible", async () => {
		const pending = harness.channel.ask("followup", "question")

		// Let ask() run up to its wait, then answer as a user would.
		await new Promise((resolve) => setTimeout(resolve, 0))
		const accepted = harness.channel.resolve("messageResponse", "answer")
		const result = await pending

		expect(accepted).toBe(true)
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("answer")
		expect(harness.windowOpenAtVisibility.length).toBeGreaterThan(0)
		expect(harness.windowOpenAtVisibility.every(Boolean)).toBe(true)
	})

	it("opens the receive window before a finalized partial ask becomes visible", async () => {
		const pending = harness.channel.ask("command", "run tests", false)

		await new Promise((resolve) => setTimeout(resolve, 0))
		const accepted = harness.channel.resolve("yesButtonClicked")
		const result = await pending

		expect(accepted).toBe(true)
		expect(result.response).toBe("yesButtonClicked")
		expect(harness.windowOpenAtVisibility.length).toBeGreaterThan(0)
		expect(harness.windowOpenAtVisibility.every(Boolean)).toBe(true)
	})

	it("delivers a response captured while the ask was still being presented", async () => {
		// Answer during presentation, before ask() reaches its wait. Under the
		// previous ordering this response was refused and the ask hung forever.
		let acceptedDuringPresentation = false
		const channel = harness.channel
		const originalPush = Reflect.get(channel, "pushMessage") as (msg: UiMessage) => void
		Reflect.set(channel, "pushMessage", (msg: UiMessage) => {
			originalPush(msg)
			if (!acceptedDuringPresentation) {
				acceptedDuringPresentation = channel.resolve("messageResponse", "early answer")
			}
		})

		const result = await channel.ask("followup", "question")

		expect(acceptedDuringPresentation).toBe(true)
		expect(result.response).toBe("messageResponse")
		expect(result.text).toBe("early answer")
	})

	it("does not leave the receive window open when a partial ask is superseded", async () => {
		await expect(harness.channel.ask("followup", "partial", true)).rejects.toThrow("Current ask promise was ignored")

		expect(Reflect.get(harness.channel, "isAwaitingAskResponse")).toBe(false)
		expect(harness.channel.resolve("messageResponse", "stray")).toBe(false)
	})
})
