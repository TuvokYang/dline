import { createInitialTaskState, type TaskState } from "@core/task/kernel"
import { DispatchInteractionRequest } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import { dispatchInteraction } from "../dispatchInteraction"

function state(kind = "followup", actionId = "reply"): TaskState {
	return {
		...createInitialTaskState("task-1"),
		revision: 12,
		generation: 3,
		flow: { phase: "paused" },
		dialog: {
			approvalsByBlock: {},
			primary: {
				interactionId: "interaction-1",
				turnId: "turn-1",
				kind,
				status: "awaiting",
				createdRevision: 11,
				presentationRef: "presentation-1",
				receiverGeneration: 3,
				actionRules: [{ actionId, payloadPolicy: "draft" }],
			},
		},
	}
}

interface ReviewedReplyFixture {
	readonly text: string
	readonly commit: () => void
}

interface ControllerOptions {
	/** What the input review claims from the reply; undefined means nothing. */
	readonly reviewed?: ReviewedReplyFixture
	readonly rejected?: boolean
}

function controller(taskState: TaskState = state(), options: ControllerOptions = {}) {
	const resolve = vi.fn()
	const respond = vi.fn(async () =>
		options.rejected
			? { kind: "rejected" as const, reason: "stale_attempt" }
			: {
					kind: "accepted" as const,
					state: taskState,
					commands: [],
					receipt: { revision: taskState.revision, durable: Promise.resolve() },
				},
	)
	const put = vi.fn(async (_payload: Uint8Array) => `payload-${put.mock.calls.length}`)
	// A reply now passes through the session's input review, which may take a
	// lifecycle command out of it. Undefined means nothing was claimed, so the
	// reply stands exactly as typed - the behavior most cases assert.
	const reviewReply = vi.fn(async (_reply: { readonly text?: string }) => options.reviewed)
	const clineMessages: Array<{ ts: number; say?: string; text?: string; interactionId?: string }> = [
		{ ts: 100, say: "text", text: "earlier row" },
	]
	const addToClineMessages = vi.fn(async (row: (typeof clineMessages)[number]) => {
		clineMessages.push(row)
	})
	return {
		value: {
			task: {
				taskId: "task-1",
				state: () => taskState,
				task: { respond },
				payloads: { put },
				inputs: { reviewReply },
				messages: { clineMessages, addToClineMessages, flushUiMessages: vi.fn(async () => {}) },
				owners: { interactions: { resolve } },
			},
		},
		respond,
		put,
		resolve,
		clineMessages,
		addToClineMessages,
	}
}

function compactReply(text = "/compact keep the API notes") {
	return DispatchInteractionRequest.create({
		taskId: "task-1",
		turnId: "turn-1",
		interactionId: "interaction-1",
		actionId: "reply",
		stateRevision: 12,
		draft: { text, images: [], files: [] },
	})
}

describe("dispatchInteraction", () => {
	it("materializes payloads and submits one canonical dialog response", async () => {
		const host = controller()
		const result = await dispatchInteraction(
			host.value as never,
			DispatchInteractionRequest.create({
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "reply",
				stateRevision: 12,
				draft: { text: "next turn", images: [], files: [] },
				selection: { values: ["item-1"] },
			}),
		)

		expect(host.put).toHaveBeenCalledTimes(2)
		expect(host.respond).toHaveBeenCalledWith({
			type: "dialog.respond",
			taskId: "task-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			stateRevision: 12,
			receiverGeneration: 3,
			actionId: "reply",
			draftRef: "payload-1",
			selectionRef: "payload-2",
		})
		expect(host.resolve).toHaveBeenCalledWith("interaction-1", {
			actionId: "reply",
			draft: { text: "next turn", images: [], files: [] },
			selection: { values: ["item-1"] },
		})
		expect(result).toMatchObject({ accepted: true, result: "accepted" })
	})

	it("maps a block-scoped approval to approval.respond", async () => {
		const taskState = state("tool_approval", "approve")
		const approval = taskState.dialog.primary!
		const scoped = { ...taskState, dialog: { approvalsByBlock: { "block-1": { ...approval, blockId: "block-1" } } } }
		const host = controller(scoped)

		await dispatchInteraction(
			host.value as never,
			DispatchInteractionRequest.create({
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 12,
			}),
		)

		expect(host.respond).toHaveBeenCalledWith(
			expect.objectContaining({ type: "approval.respond", blockId: "block-1", approved: true }),
		)
	})

	it("rejects stale identity and unsupported actions before shell submission", async () => {
		const host = controller()
		const stale = await dispatchInteraction(
			host.value as never,
			DispatchInteractionRequest.create({
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "reply",
				stateRevision: 11,
			}),
		)
		const invalid = await dispatchInteraction(
			host.value as never,
			DispatchInteractionRequest.create({
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "unsupported",
				stateRevision: 12,
			}),
		)

		expect(stale).toMatchObject({ accepted: false, result: "stale_interaction" })
		expect(invalid).toMatchObject({ accepted: false, result: "invalid_action" })
		expect(host.respond).not.toHaveBeenCalled()
	})

	it("shows a reply the compact command consumed entirely, exactly as typed", async () => {
		const commit = vi.fn()
		const host = controller(state(), { reviewed: { text: "", commit } })

		const result = await dispatchInteraction(host.value as never, compactReply())

		expect(result).toMatchObject({ accepted: true, result: "accepted" })
		const feedback = host.clineMessages.filter((row) => row.say === "user_feedback")
		expect(feedback).toEqual([
			expect.objectContaining({
				type: "say",
				say: "user_feedback",
				text: "/compact keep the API notes",
				interactionId: "reply:interaction-1",
			}),
		])
		// The row sorts after the dialog it answers, even under a skewed clock.
		expect(feedback[0].ts).toBeGreaterThan(100)
		expect(commit).toHaveBeenCalledOnce()
		// The handler receives only what the command left: nothing.
		expect(host.resolve).toHaveBeenCalledWith(
			"interaction-1",
			expect.objectContaining({ draft: { text: "", images: [], files: [] } }),
		)
	})

	it("shows a consumed reply once when the same dispatch is replayed", async () => {
		const host = controller(state(), { reviewed: { text: "", commit: vi.fn() } })

		await dispatchInteraction(host.value as never, compactReply())
		await dispatchInteraction(host.value as never, compactReply())

		expect(host.clineMessages.filter((row) => row.say === "user_feedback")).toHaveLength(1)
	})

	it("leaves the row to the dialog handler when the command keeps some text", async () => {
		const host = controller(state(), { reviewed: { text: "then continue", commit: vi.fn() } })

		await dispatchInteraction(host.value as never, compactReply("then continue /compact"))

		expect(host.addToClineMessages).not.toHaveBeenCalled()
		expect(host.resolve).toHaveBeenCalledWith(
			"interaction-1",
			expect.objectContaining({ draft: { text: "then continue", images: [], files: [] } }),
		)
	})

	it("shows nothing and runs no command when the runtime rejects the reply", async () => {
		const commit = vi.fn()
		const host = controller(state(), { reviewed: { text: "", commit }, rejected: true })

		const result = await dispatchInteraction(host.value as never, compactReply())

		expect(result).toMatchObject({ accepted: false, result: "stale_interaction" })
		expect(host.addToClineMessages).not.toHaveBeenCalled()
		expect(commit).not.toHaveBeenCalled()
		expect(host.resolve).not.toHaveBeenCalled()
	})

	it("returns missing task when no runtime and no history display own the interaction", async () => {
		const result = await dispatchInteraction(
			{ dispatchHistoryDisplayInteraction: async () => undefined } as never,
			DispatchInteractionRequest.create({ taskId: "task-1", turnId: "turn-1", interactionId: "interaction-1" }),
		)
		expect(result).toMatchObject({ accepted: false, result: "missing_task" })
	})
})
