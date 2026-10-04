import { InMemoryToolApprovalFeedbackLedger } from "@core/task/executors/tool/ToolApprovalFeedbackLedger"
import { createInitialTaskState, type TaskState } from "@core/task/kernel"
import { SemanticInputDocument as WireDocument, SemanticInputNode as WireNode } from "@shared/proto/dline/input"
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
	/** Make the chat-row write fail, as a broken message store would. */
	readonly rowWriteFails?: boolean
}

function controller(taskState: TaskState = state(), options: ControllerOptions = {}) {
	const resolve = vi.fn()
	const presentDenial = vi.fn(async () => undefined)
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
		if (options.rowWriteFails) throw new Error("message store unavailable")
		clineMessages.push(row)
	})
	const approvalFeedback = new InMemoryToolApprovalFeedbackLedger()
	return {
		value: {
			task: {
				taskId: "task-1",
				state: () => taskState,
				task: { respond },
				payloads: { put },
				inputs: { reviewReply },
				approvalFeedback,
				messages: { clineMessages, addToClineMessages, flushUiMessages: vi.fn(async () => {}) },
				owners: { interactions: { resolve }, toolExecution: { presentDenial } },
			},
		},
		respond,
		put,
		resolve,
		presentDenial,
		clineMessages,
		addToClineMessages,
		approvalFeedback,
	}
}

function approvalState(): TaskState {
	const taskState = state("tool_approval", "approve")
	const approval = {
		...taskState.dialog.primary!,
		actionRules: [
			{ actionId: "approve", payloadPolicy: "draft" as const },
			{ actionId: "reject", payloadPolicy: "draft" as const },
		],
	}
	return {
		...taskState,
		turn: {
			...taskState.turn,
			blocks: [
				{
					blockId: "block-1",
					index: 0,
					phase: "awaiting_approval",
					attempt: "attempt-1",
					lanes: [],
					turnEnding: false,
					invocationRef: "invocation:block-1",
				},
			],
			manualApprovalBlockIds: ["block-1"],
		},
		dialog: { approvalsByBlock: { "block-1": { ...approval, blockId: "block-1" } } },
	}
}

function approveWith(text: string) {
	return DispatchInteractionRequest.create({
		taskId: "task-1",
		turnId: "turn-1",
		interactionId: "interaction-1",
		actionId: "approve",
		stateRevision: 12,
		draft: { text, images: [], files: [] },
	})
}

function rejectApproval() {
	return DispatchInteractionRequest.create({
		taskId: "task-1",
		turnId: "turn-1",
		interactionId: "interaction-1",
		actionId: "reject",
		stateRevision: 12,
	})
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

	it("accepts an awaiting approval observed before an unrelated task revision", async () => {
		const host = controller(approvalState())

		const result = await dispatchInteraction(
			host.value as never,
			DispatchInteractionRequest.create({
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: "approve",
				stateRevision: 11,
				draft: { text: "approve from the observed view", images: [], files: [] },
			}),
		)

		expect(result).toMatchObject({ accepted: true, result: "accepted" })
		expect(host.respond).toHaveBeenCalledWith(
			expect.objectContaining({
				type: "approval.respond",
				interactionId: "interaction-1",
				stateRevision: 11,
				receiverGeneration: 3,
			}),
		)
	})

	it("presents one handler-owned terminal state after an accepted manual rejection", async () => {
		const host = controller(approvalState())

		const result = await dispatchInteraction(host.value as never, rejectApproval())

		expect(result).toMatchObject({ accepted: true, result: "accepted" })
		expect(host.respond).toHaveBeenCalledWith(
			expect.objectContaining({ type: "approval.respond", blockId: "block-1", approved: false }),
		)
		expect(host.presentDenial).toHaveBeenCalledOnce()
		expect(host.presentDenial).toHaveBeenCalledWith("invocation:block-1")
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
				stateRevision: 10,
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

	it("refuses a reply whose structure cannot be decoded instead of sending it as live text", async () => {
		const host = controller()
		const request = DispatchInteractionRequest.create({
			...compactReply("/compact pasted from a log"),
			draft: {
				text: "/compact pasted from a log",
				images: [],
				files: [],
				semanticInput: WireDocument.create({ nodes: [WireNode.create({})] }),
			},
		})

		const result = await dispatchInteraction(host.value as never, request)

		expect(result).toMatchObject({ accepted: false, result: "invalid_payload" })
		expect(host.respond).not.toHaveBeenCalled()
		expect(host.resolve).not.toHaveBeenCalled()
	})

	it("keeps the accepted approval's feedback when a later response for the block is refused", async () => {
		const host = controller(approvalState(), { rejected: true })
		host.approvalFeedback.record("block-1", { text: "read it as UTF-8" })

		const result = await dispatchInteraction(host.value as never, approveWith("a stale second click"))

		expect(result).toMatchObject({ accepted: false })
		expect(host.approvalFeedback.take("block-1")).toEqual({ text: "read it as UTF-8" })
	})

	it("records the feedback an accepted approval carries for its block", async () => {
		const host = controller(approvalState())

		await dispatchInteraction(host.value as never, approveWith("read it as UTF-8"))

		expect(host.approvalFeedback.take("block-1")).toMatchObject({ text: "read it as UTF-8" })
	})

	it("continues an accepted approval only through the kernel, never as a new submission", async () => {
		const host = controller(approvalState())

		const result = await dispatchInteraction(host.value as never, approveWith("read it as UTF-8"))

		expect(result).toMatchObject({ accepted: true, result: "accepted" })
		expect(host.respond).toHaveBeenCalledWith(
			expect.objectContaining({ type: "approval.respond", blockId: "block-1", approved: true, draftRef: "payload-1" }),
		)
		// The note reaches the next request through the block's feedback, after
		// the tool result. Handing the approval to the interaction owner as well
		// resubmitted the note as user input and composed a round before the
		// tool result existed.
		expect(host.approvalFeedback.take("block-1")).toMatchObject({ text: "read it as UTF-8" })
		expect(host.resolve).not.toHaveBeenCalled()
	})

	it("still runs the command and answers the dialog when the consumed reply cannot be shown", async () => {
		const commit = vi.fn()
		const host = controller(state(), { reviewed: { text: "", commit }, rowWriteFails: true })

		const result = await dispatchInteraction(host.value as never, compactReply())

		expect(result).toMatchObject({ accepted: true, result: "accepted" })
		expect(commit).toHaveBeenCalledOnce()
		expect(host.resolve).toHaveBeenCalledWith("interaction-1", expect.objectContaining({ actionId: "reply" }))
	})

	it("returns missing task when no runtime and no history display own the interaction", async () => {
		const result = await dispatchInteraction(
			{ dispatchHistoryDisplayInteraction: async () => undefined } as never,
			DispatchInteractionRequest.create({ taskId: "task-1", turnId: "turn-1", interactionId: "interaction-1" }),
		)
		expect(result).toMatchObject({ accepted: false, result: "missing_task" })
	})
})
