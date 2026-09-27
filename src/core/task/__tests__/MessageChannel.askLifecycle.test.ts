import type { UiMessage } from "@shared/ExtensionMessage"
import { beforeEach, describe, expect, it } from "vitest"
import { type AskLifecycleRecord, MessageChannel } from "../MessageChannel"
import { TaskState } from "../TaskState"

/**
 * A stranded ask leaves no trace of its own: the wait is silent, and the log
 * shows only that the task stopped progressing. Reconstructing what happened
 * then depends on inferring intent from surrounding timestamps, which is what
 * made an eight-hour hang unreadable.
 *
 * These tests pin the transitions the channel must report, so a later reader
 * can tell an ask still waiting on a user from one whose answer never arrived.
 */

interface Harness {
	channel: MessageChannel
	taskState: TaskState
	messages: UiMessage[]
	records: AskLifecycleRecord[]
	events: () => string[]
}

function createHarness(): Harness {
	const taskState = new TaskState()
	const messages: UiMessage[] = []
	const records: AskLifecycleRecord[] = []
	let nextTs = 1000

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
		pushMessage: () => undefined,
		syncState: async () => undefined,
		messageStateHandler: messageStateHandler as never,
		taskState,
		getProviderInfo: () => ({}) as never,
		genTs: () => nextTs++,
		recordAskLifecycle: (record) => {
			records.push(record)
		},
	})

	return { channel, taskState, messages, records, events: () => records.map((record) => record.event) }
}

describe("MessageChannel ask lifecycle reporting", () => {
	let harness: Harness

	beforeEach(() => {
		harness = createHarness()
	})

	/**
	 * The window has to be reported as open before the question is presented.
	 * If those two ever appeared in the other order, the log would be showing
	 * exactly the race that strands an ask.
	 */
	it("reports the window opening before the question is presented", async () => {
		const pending = harness.channel.ask("followup", "question")

		await new Promise((resolve) => setTimeout(resolve, 0))
		harness.channel.resolve("messageResponse", "answer")
		await pending

		expect(harness.events()).toEqual(["window_open", "ui_presented", "response_received"])
	})

	it("reports the same sequence for a finalized partial ask", async () => {
		const pending = harness.channel.ask("command", "run tests", false)

		await new Promise((resolve) => setTimeout(resolve, 0))
		harness.channel.resolve("yesButtonClicked")
		await pending

		expect(harness.events()).toEqual(["window_open", "ui_presented", "response_received"])
	})

	/**
	 * Every record names the question it belongs to. Concurrent asks and
	 * replayed timestamps otherwise make the records unattributable.
	 */
	it("attributes each record to the ask kind and timestamp", async () => {
		const pending = harness.channel.ask("followup", "question")

		await new Promise((resolve) => setTimeout(resolve, 0))
		harness.channel.resolve("messageResponse", "answer")
		await pending

		const timestamps = new Set(harness.records.map((record) => record.askTs))
		expect(timestamps.size).toBe(1)
		expect(harness.records.every((record) => record.ask === "followup")).toBe(true)
	})

	/**
	 * Wait duration is the fact that separates a user taking their time from a
	 * response that never arrived, so it must be present from the moment the
	 * window opens rather than only on the terminal record.
	 */
	it("reports elapsed time from the moment the window opened", async () => {
		const pending = harness.channel.ask("followup", "question")

		await new Promise((resolve) => setTimeout(resolve, 0))
		harness.channel.resolve("messageResponse", "answer")
		await pending

		expect(harness.records.every((record) => typeof record.elapsedMs === "number")).toBe(true)
		const received = harness.records.at(-1)
		expect(received?.elapsedMs).toBeGreaterThanOrEqual(0)
	})

	/**
	 * A response arriving with no ask waiting is refused, and refusing it must
	 * leave no trace that a later ask could mistake for its own answer.
	 */
	it("reports nothing for a response refused while no ask was waiting", async () => {
		expect(harness.channel.resolve("messageResponse", "typed while working")).toBe(false)

		expect(harness.records).toHaveLength(0)
	})

	/**
	 * An ask abandoned because the conversation moved on is a normal outcome,
	 * but it must be distinguishable from one that received an answer.
	 */
	it("reports an ask abandoned after being superseded", async () => {
		const pending = harness.channel.ask("followup", "question")
		await new Promise((resolve) => setTimeout(resolve, 0))

		// A later message supersedes the pending question.
		harness.messages.push({ ts: 2000, type: "say", say: "text", text: "moved on" } as UiMessage)

		await expect(pending).rejects.toThrow("Current ask promise was ignored")

		const abandoned = harness.records.at(-1)
		expect(abandoned?.event).toBe("abandoned")
		expect(abandoned?.reason).toBe("superseded")
	})

	it("reports an ask abandoned by task abort", async () => {
		const pending = harness.channel.ask("followup", "question")
		await new Promise((resolve) => setTimeout(resolve, 0))

		harness.taskState.abort = true

		await expect(pending).rejects.toThrow("Dline instance aborted")

		const abandoned = harness.records.at(-1)
		expect(abandoned?.event).toBe("abandoned")
		expect(abandoned?.reason).toBe("aborted")
	})

	/**
	 * The sink is optional so the channel keeps working without diagnostics.
	 * A channel that only functioned when observed would be a liability.
	 */
	it("works without a lifecycle sink", async () => {
		const taskState = new TaskState()
		const messages: UiMessage[] = []
		let nextTs = 1000
		const channel = new MessageChannel({
			pushMessage: () => undefined,
			syncState: async () => undefined,
			messageStateHandler: {
				clineMessages: messages,
				addToClineMessages: async (message: UiMessage) => {
					messages.push(message)
				},
				upsertClineMessageInMemory: async (message: UiMessage) => message,
				finalizeClineMessage: async (message: UiMessage) => message,
				updateClineMessage: async () => undefined,
				flushUiMessages: async () => undefined,
			} as never,
			taskState,
			getProviderInfo: () => ({}) as never,
			genTs: () => nextTs++,
		})

		const pending = channel.ask("followup", "question")
		await new Promise((resolve) => setTimeout(resolve, 0))
		channel.resolve("messageResponse", "answer")

		await expect(pending).resolves.toMatchObject({ text: "answer" })
	})
})
