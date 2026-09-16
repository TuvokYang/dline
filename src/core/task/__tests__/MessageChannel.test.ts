import { strict as assert } from "node:assert"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, it, vi } from "vitest"
import { MessageChannel } from "../MessageChannel"
import type { MessageStateHandler } from "../message-state"
import type { TaskState } from "../TaskState"

function createMessageChannel(
	options: { pushMessage?: (message: ClineMessage) => void | Promise<void>; syncState?: () => Promise<void> } = {},
) {
	const clineMessages: ClineMessage[] = []
	const taskState = {
		abort: false,
		askResponse: undefined,
		askResponseText: undefined,
		askResponseImages: undefined,
		askResponseFiles: undefined,
		lastMessageTs: undefined,
	} as TaskState

	let lastTs = 0
	const flushUiMessages = vi.fn(async () => {})
	const flushMessageUpdate = vi.fn(async () => {})
	const channel = new MessageChannel({
		pushMessage: options.pushMessage ?? (() => {}),
		syncState: options.syncState ?? (async () => {}),
		messageStateHandler: {
			get clineMessages() {
				return clineMessages
			},
			addToClineMessages: async (message: ClineMessage) => {
				clineMessages.push(message)
			},
			updateClineMessage: async (index: number, updates: Partial<ClineMessage>) => {
				Object.assign(clineMessages[index], updates)
			},
			flushUiMessages,
			flushMessageUpdate,
			upsertClineMessageInMemory: async (message: ClineMessage) => {
				const index = clineMessages.findIndex((candidate) => candidate.ts === message.ts)
				if (index >= 0) {
					clineMessages[index] = message
				} else {
					clineMessages.push(message)
				}
				return message
			},
			finalizeClineMessage: async (message: ClineMessage) => {
				const index = clineMessages.findIndex((candidate) => candidate.ts === message.ts)
				if (index >= 0) {
					clineMessages[index] = message
				} else {
					clineMessages.push(message)
				}
				return message
			},
		} as unknown as MessageStateHandler,
		taskState,
		getProviderInfo: () => ({ providerId: "test", modelId: "test-model", mode: "act" }),
		genTs: () => ++lastTs,
	})

	return { channel, clineMessages, taskState, flushUiMessages, flushMessageUpdate }
}

async function flushMicrotasks(iterations = 5) {
	for (let i = 0; i < iterations; i++) {
		await Promise.resolve()
	}
}

describe("MessageChannel.say", () => {
	it("allows lifecycle state snapshots while the task is aborted", async () => {
		const { channel, clineMessages, taskState } = createMessageChannel()
		taskState.abort = true

		await channel.say("state_snapshot", JSON.stringify({ phase: "cancelling", apiIndex: 1, timestamp: Date.now() }))

		assert.equal(clineMessages.length, 1)
		assert.equal(clineMessages[0].say, "state_snapshot")
	})

	it("rejects regular visible messages while the task is aborted", async () => {
		const { channel, taskState } = createMessageChannel()
		taskState.abort = true

		await assert.rejects(channel.say("text", "should not continue after abort"), /Dline instance aborted/)
	})
})

describe("MessageChannel.presentAsk", () => {
	it("finalizes a transient presentation row before exposing it as a durable ask", async () => {
		const { channel, clineMessages, flushMessageUpdate } = createMessageChannel()
		clineMessages.push({ ts: 100, type: "say", say: "tool", text: "partial summary", partial: true })

		await expect(channel.presentAsk("condense", "review summary", 100, "condense-1")).resolves.toBe(100)

		expect(clineMessages).toHaveLength(1)
		expect(clineMessages[0]).toMatchObject({
			ts: 100,
			type: "ask",
			ask: "condense",
			text: "review summary",
			partial: false,
			interactionId: "condense-1",
		})
		expect(flushMessageUpdate).not.toHaveBeenCalled()
	})

	it("waits for realtime ask delivery before exposing the awaiting interaction", async () => {
		let releaseDelivery: (() => void) | undefined
		const delivery = new Promise<void>((resolve) => {
			releaseDelivery = resolve
		})
		const pushMessage = vi.fn(async () => delivery)
		const { channel } = createMessageChannel({ pushMessage })
		let settled = false

		const presentation = channel.presentAsk("qna_respond", '{"response":"ready"}', 100, "qna-1")
		void presentation.then(() => {
			settled = true
		})
		await flushMicrotasks()

		expect(pushMessage).toHaveBeenCalledOnce()
		expect(settled).toBe(false)

		releaseDelivery?.()
		await expect(presentation).resolves.toBe(100)
	})

	it("delivers a completion say before upgrading the same row to its ask anchor", async () => {
		let releaseCompletionSay: (() => void) | undefined
		const completionSayDelivery = new Promise<void>((resolve) => {
			releaseCompletionSay = resolve
		})
		const delivered: string[] = []
		const pushMessage = vi.fn(async (message: ClineMessage) => {
			const identity = `${message.type}:${message.ask ?? message.say}`
			if (message.type === "say" && message.say === "completion_result") {
				await completionSayDelivery
			}
			delivered.push(identity)
		})
		const { channel, clineMessages, flushMessageUpdate } = createMessageChannel({ pushMessage })

		const completionFlow = (async () => {
			await channel.say("completion_result", "done", undefined, undefined, false, 100)
			await channel.presentAsk("completion_result", "done", 100, "completion-1")
		})()
		await flushMicrotasks()

		expect(pushMessage).toHaveBeenCalledOnce()
		releaseCompletionSay?.()
		await completionFlow

		expect(delivered).toEqual(["say:completion_result", "ask:completion_result"])
		expect(clineMessages).toHaveLength(1)
		expect(clineMessages[0]).toMatchObject({
			ts: 100,
			type: "ask",
			ask: "completion_result",
			interactionId: "completion-1",
		})
		assert.equal(clineMessages[0].say, undefined)
		assert.deepEqual(flushMessageUpdate.mock.calls, [[0]])
	})

	it("resets a reused command message from a terminal state to pending", async () => {
		const { channel, clineMessages } = createMessageChannel()
		await channel.say("command", "echo ready")
		const commandMessage = clineMessages[0]
		assert.ok(commandMessage)
		commandMessage.commandStatus = "completed"
		commandMessage.exitCode = 0

		await channel.presentAsk("command", "echo ready.REQ_APP", commandMessage.ts)

		assert.equal(clineMessages.length, 1)
		assert.equal(clineMessages[0].type, "ask")
		assert.equal(clineMessages[0].ask, "command")
		assert.equal(clineMessages[0].text, "echo ready.REQ_APP")
		assert.equal(clineMessages[0].partial, false)
		assert.equal(clineMessages[0].commandStatus, "pending")
		assert.equal(clineMessages[0].exitCode, undefined)
	})

	it("keeps a rejected tool ask as a persisted timeline presentation", async () => {
		const { channel, clineMessages } = createMessageChannel()
		const presentation = JSON.stringify({ tool: "editedExistingFile", path: "src/example.ts" })

		const messageTs = await channel.presentAsk("tool", presentation)
		channel.resolve("noButtonClicked", "not now")

		assert.equal(clineMessages.length, 1)
		assert.deepEqual(clineMessages[0], {
			ts: messageTs,
			type: "ask",
			say: undefined,
			ask: "tool",
			text: presentation,
			partial: false,
		})
	})

	it("sets pending for a new command ask without assigning command status to other asks", async () => {
		const { channel, clineMessages } = createMessageChannel()

		await channel.presentAsk("command", "echo ready.REQ_APP")
		await channel.presentAsk("qna_respond", '{"response":"ready"}')

		assert.equal(clineMessages[0].commandStatus, "pending")
		assert.equal(clineMessages[1].commandStatus, undefined)
	})
})

describe("MessageChannel.presentSay", () => {
	it("upserts one durable user feedback row by interaction identity", async () => {
		const { channel, clineMessages, flushMessageUpdate, flushUiMessages } = createMessageChannel()

		const firstTs = await channel.presentSay("user_feedback", "continue after cancel", ["image"], ["file"], "resume-1")
		const retryTs = await channel.presentSay("user_feedback", "continue after cancel", ["image"], ["file"], "resume-1")

		assert.equal(retryTs, firstTs)
		assert.equal(clineMessages.length, 1)
		assert.deepEqual(clineMessages[0], {
			ts: firstTs,
			type: "say",
			say: "user_feedback",
			text: "continue after cancel",
			images: ["image"],
			files: ["file"],
			partial: false,
			interactionId: "resume-1",
			modelInfo: { providerId: "test", modelId: "test-model", mode: "act" },
		})
		assert.equal(flushUiMessages.mock.calls.length, 1)
		assert.deepEqual(flushMessageUpdate.mock.calls, [[0]])
	})
})

describe("MessageChannel.ask", () => {
	it("uses the canonical ignored-promise diagnostic for a partial ask", async () => {
		const { channel, clineMessages } = createMessageChannel()

		await assert.rejects(channel.ask("qna_respond", '{"response":"partial"}', true), {
			message: "Current ask promise was ignored",
		})

		assert.equal(clineMessages.length, 1)
		assert.equal(clineMessages[0].partial, true)
	})

	it("does not treat state_snapshot messages as superseding a pending ask", async () => {
		const clock = vi.useFakeTimers()
		const { channel } = createMessageChannel()

		try {
			const askPromise = channel.ask("resume_task")
			let settled = false
			void askPromise.then(
				() => {
					settled = true
				},
				() => {
					settled = true
				},
			)

			await flushMicrotasks()
			await channel.say("state_snapshot", JSON.stringify({ phase: "streaming", apiIndex: -1, timestamp: Date.now() }))
			await clock.advanceTimersByTimeAsync(200)

			assert.equal(settled, false)

			channel.resolve("yesButtonClicked")
			await clock.advanceTimersByTimeAsync(100)

			const result = await askPromise
			assert.equal(result.response, "yesButtonClicked")
		} finally {
			clock.useRealTimers()
		}
	})

	it("allows user_feedback created by the current ask response before the ask settles", async () => {
		const clock = vi.useFakeTimers()
		const { channel, clineMessages } = createMessageChannel()

		try {
			const askPromise = channel.ask("qna_respond")

			await flushMicrotasks()
			channel.resolve("messageResponse", "My lord response")
			await channel.say("user_feedback", "My lord response")
			await clock.advanceTimersByTimeAsync(100)

			const result = await askPromise
			assert.equal(result.response, "messageResponse")
			assert.equal(result.text, "My lord response")
			assert.equal(clineMessages.at(-1)?.say, "user_feedback")
		} finally {
			clock.useRealTimers()
		}
	})

	it("allows checkpoint side effects created by the current ask response before the ask settles", async () => {
		const clock = vi.useFakeTimers()
		const { channel, clineMessages } = createMessageChannel()

		try {
			const askPromise = channel.ask("qna_respond")

			await flushMicrotasks()
			channel.resolve("messageResponse", "My lord response")
			await channel.say("user_feedback", "My lord response")
			await channel.say("checkpoint_created")
			await clock.advanceTimersByTimeAsync(100)

			const result = await askPromise
			assert.equal(result.response, "messageResponse")
			assert.equal(result.text, "My lord response")
			assert.equal(clineMessages.at(-1)?.say, "checkpoint_created")
		} finally {
			clock.useRealTimers()
		}
	})

	it("still treats non-internal messages as superseding a pending ask", async () => {
		const clock = vi.useFakeTimers()
		const { channel } = createMessageChannel()

		try {
			const askPromise = channel.ask("resume_task")
			const rejection = assert.rejects(askPromise, { message: "Current ask promise was ignored" })

			await flushMicrotasks()
			await channel.say("text", "new visible message")
			await clock.advanceTimersByTimeAsync(100)

			await rejection
		} finally {
			clock.useRealTimers()
		}
	})
})

/**
 * A response is only meaningful to the ask that is waiting for it.
 *
 * `resolve` used to park its argument in `taskState` unconditionally. With
 * nothing waiting, that value survived until the next unrelated `ask()` read
 * it as its own answer, so text the user typed while the task was working
 * entered the conversation as a reply to a question they never saw.
 */
describe("MessageChannel.resolve without a waiting ask", () => {
	it("refuses a response when no ask is waiting", () => {
		const { channel, taskState } = createMessageChannel()

		assert.equal(channel.resolve("messageResponse", "typed while the task was working"), false)
		assert.equal(taskState.askResponse, undefined)
		assert.equal(taskState.askResponseText, undefined)
	})

	it("does not let a refused response answer the next unrelated ask", async () => {
		const clock = vi.useFakeTimers()
		const { channel } = createMessageChannel()

		try {
			// Arrives while the task is working, with nothing waiting for it.
			assert.equal(channel.resolve("messageResponse", "ghost response"), false)

			// A later, unrelated question must not find that value sitting there.
			const askPromise = channel.ask("qna_respond")
			let settled = false
			void askPromise.then(
				() => {
					settled = true
				},
				() => {
					settled = true
				},
			)
			await flushMicrotasks()
			await clock.advanceTimersByTimeAsync(300)

			assert.equal(settled, false)

			// The real answer still resolves it normally.
			assert.equal(channel.resolve("messageResponse", "real answer"), true)
			await clock.advanceTimersByTimeAsync(100)

			const result = await askPromise
			assert.equal(result.text, "real answer")
		} finally {
			clock.useRealTimers()
		}
	})

	it("stops accepting responses once the ask has settled", async () => {
		const clock = vi.useFakeTimers()
		const { channel } = createMessageChannel()

		try {
			const askPromise = channel.ask("qna_respond")
			await flushMicrotasks()
			assert.equal(channel.resolve("messageResponse", "answer"), true)
			await clock.advanceTimersByTimeAsync(100)
			await askPromise

			assert.equal(channel.resolve("messageResponse", "too late"), false)
		} finally {
			clock.useRealTimers()
		}
	})

	// An abandoned ask must not leave the channel accepting responses for a
	// question that is no longer being asked.
	it("stops accepting responses after a superseded ask is abandoned", async () => {
		const clock = vi.useFakeTimers()
		const { channel } = createMessageChannel()

		try {
			const askPromise = channel.ask("resume_task")
			const rejection = assert.rejects(askPromise, { message: "Current ask promise was ignored" })

			await flushMicrotasks()
			await channel.say("text", "new visible message")
			await clock.advanceTimersByTimeAsync(100)
			await rejection

			assert.equal(channel.resolve("messageResponse", "orphaned"), false)
		} finally {
			clock.useRealTimers()
		}
	})
})
