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

function controller(taskState: TaskState = state()) {
	const resolve = vi.fn()
	const respond = vi.fn(async () => ({
		kind: "accepted" as const,
		state: taskState,
		commands: [],
		receipt: { revision: taskState.revision, durable: Promise.resolve() },
	}))
	const put = vi.fn(async (_payload: Uint8Array) => `payload-${put.mock.calls.length}`)
	return {
		value: {
			task: {
				taskId: "task-1",
				state: () => taskState,
				task: { respond },
				payloads: { put },
				owners: { interactions: { resolve } },
			},
		},
		respond,
		put,
		resolve,
	}
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

	it("returns missing task without dispatch", async () => {
		const result = await dispatchInteraction(
			{} as never,
			DispatchInteractionRequest.create({ taskId: "task-1", turnId: "turn-1", interactionId: "interaction-1" }),
		)
		expect(result).toMatchObject({ accepted: false, result: "missing_task" })
	})
})
