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

/** A sequence whose ids are recognisable in assertions. */
function sequence(start = 1000): () => number {
	let last = start
	return () => ++last
}

/** Prepare and commit one submission, which is what an accepted submit does. */
async function present(presenter: TaskInputPresenter, entryId: string): Promise<void> {
	const prepared = await presenter.prepare({ entryId, payloadRef: `ref:${entryId}` })
	await prepared.commit()
}

describe("TaskInputPresenter", () => {
	it("opens the task with what the user typed, not the admitted projection", async () => {
		const state = messageState()
		const presenter = new TaskInputPresenter(
			payloadStore({ text: "/compact please", admittedText: "<compact-instructions> please" }),
			state.messages,
			sequence(),
		)

		await present(presenter, "entry-1")

		expect(state.rows).toEqual([
			expect.objectContaining({ type: "say", say: "task", text: "/compact please", interactionId: "entry-1" }),
		])
	})

	it("withholds the row until the submission is accepted", async () => {
		const state = messageState()
		const presenter = new TaskInputPresenter(payloadStore({ text: "refused" }), state.messages, sequence())

		const prepared = await presenter.prepare({ entryId: "entry-1", payloadRef: "ref-1" })

		expect(state.rows).toEqual([])
		await prepared.commit()
		expect(state.rows).toHaveLength(1)
	})

	it("shows a later submission as user feedback", async () => {
		const state = messageState()
		const ids = sequence()
		const presenter = new TaskInputPresenter(payloadStore({ text: "first" }), state.messages, ids)
		await present(presenter, "entry-1")

		await present(new TaskInputPresenter(payloadStore({ text: "second" }), state.messages, ids), "entry-2")

		expect(state.rows.map((row) => row.say)).toEqual(["task", "user_feedback"])
	})

	it("keeps one row for a replayed entry", async () => {
		const state = messageState()
		const presenter = new TaskInputPresenter(payloadStore({ text: "hello" }), state.messages, sequence())

		await present(presenter, "entry-1")
		await present(presenter, "entry-1")

		expect(state.rows).toHaveLength(1)
	})

	it("carries the images and files the submission attached", async () => {
		const state = messageState()
		const presenter = new TaskInputPresenter(
			payloadStore({ text: "look", images: ["image-1"], files: ["file-1"] }),
			state.messages,
			sequence(),
		)

		await present(presenter, "entry-1")

		expect(state.rows[0]).toMatchObject({ images: ["image-1"], files: ["file-1"] })
	})
})
