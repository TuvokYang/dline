import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import type { MessageStateHandler } from "../../message-state"
import type { TaskPayloadStore } from "../../stores"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { TaskInputPresenter } from "../TaskInputPresenter"

function messageState() {
	const rows: ClineMessage[] = []
	const messages = {
		get clineMessages() {
			return rows
		},
		addToClineMessages: async (message: Partial<ClineMessage>) => {
			rows.push(message as ClineMessage)
		},
	} as unknown as MessageStateHandler
	return { messages, rows }
}

function payloadStore(envelope: Partial<UserInputEnvelope>): TaskPayloadStore {
	return {
		read: async () => encodeTaskPayload({ kind: "user_input", entryId: "entry-1", ...envelope }),
	} as unknown as TaskPayloadStore
}

describe("TaskInputPresenter", () => {
	it("opens the task with what the user typed, not the admitted projection", async () => {
		const state = messageState()
		const presenter = new TaskInputPresenter(
			payloadStore({ text: "/compact please", admittedText: "<compact-instructions> please" }),
			state.messages,
		)

		await presenter.present({ entryId: "entry-1", payloadRef: "ref-1" })

		expect(state.rows).toEqual([
			expect.objectContaining({ type: "say", say: "task", text: "/compact please", interactionId: "entry-1" }),
		])
	})

	it("shows a later submission as user feedback", async () => {
		const state = messageState()
		const presenter = new TaskInputPresenter(payloadStore({ text: "first" }), state.messages)
		await presenter.present({ entryId: "entry-1", payloadRef: "ref-1" })

		await new TaskInputPresenter(payloadStore({ text: "second" }), state.messages).present({
			entryId: "entry-2",
			payloadRef: "ref-2",
		})

		expect(state.rows.map((row) => row.say)).toEqual(["task", "user_feedback"])
	})

	it("keeps one row for a replayed entry", async () => {
		const state = messageState()
		const presenter = new TaskInputPresenter(payloadStore({ text: "hello" }), state.messages)

		await presenter.present({ entryId: "entry-1", payloadRef: "ref-1" })
		await presenter.present({ entryId: "entry-1", payloadRef: "ref-1" })

		expect(state.rows).toHaveLength(1)
	})

	it("carries the images and files the submission attached", async () => {
		const state = messageState()
		const presenter = new TaskInputPresenter(
			payloadStore({ text: "look", images: ["image-1"], files: ["file-1"] }),
			state.messages,
		)

		await presenter.present({ entryId: "entry-1", payloadRef: "ref-1" })

		expect(state.rows[0]).toMatchObject({ images: ["image-1"], files: ["file-1"] })
	})
})
