import { describe, expect, it } from "vitest"
import type { ActiveInteraction } from "../../interaction/InteractionReducer"
import { reduceInteraction } from "../../interaction/InteractionReducer"
import type { InteractionResponse } from "../../interaction/InteractionResponse"
import { transition } from "../transition"
import type { TaskEvent, TaskState, TransitionResult } from "../types"
import { createInitialTaskState } from "../types"

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
	expect(result.kind).toBe("accepted")
	if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
	return result
}

function runningState(): TaskState {
	return {
		...createInitialTaskState("task-1"),
		flow: { phase: "running" },
		turn: { turnId: "turn-1", mode: "serial", blocks: [], automaticApprovalBlockIds: [], executingBlockIds: [] },
	}
}

function openQuestion(state: TaskState, interactionId = "i-1"): TaskState {
	const events: TaskEvent[] = [
		{
			type: "dialog.requested",
			generation: 0,
			interactionId,
			turnId: "turn-1",
			kind: "followup",
			presentationRef: `question:${interactionId}`,
			actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
		},
		{ type: "dialog.prepared", generation: 0, interactionId, journalRef: "journal:0:1", receiverGeneration: 7 },
		{ type: "dialog.presented", generation: 0, interactionId },
	]
	return events.reduce((current, event) => accepted(transition(current, event)).state, state)
}

function response(stateRevision: number, interactionId = "i-1"): Extract<TaskEvent, { type: "dialog.responded" }> {
	return {
		type: "dialog.responded",
		generation: 0,
		taskId: "task-1",
		turnId: "turn-1",
		interactionId,
		stateRevision,
		receiverGeneration: 7,
		actionId: "reply",
		draftRef: "draft:1",
	}
}

describe("task kernel causal dialog", () => {
	it("matches the legacy reducer for accepted and rejected response classes", () => {
		const state = openQuestion(runningState())
		const legacy: ActiveInteraction = {
			taskId: "task-1",
			turnId: "turn-1",
			interactionId: "i-1",
			kind: "followup",
			status: "awaiting",
			createdRevision: 1,
		}
		const scenarios: InteractionResponse[] = [
			{
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "i-1",
				stateRevision: 3,
				actionId: "reply",
				draft: { text: "", images: [], files: [] },
			},
			{
				taskId: "wrong",
				turnId: "turn-1",
				interactionId: "i-1",
				stateRevision: 3,
				actionId: "reply",
				draft: { text: "", images: [], files: [] },
			},
			{
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "i-1",
				stateRevision: 0,
				actionId: "reply",
				draft: { text: "", images: [], files: [] },
			},
			{ taskId: "task-1", turnId: "turn-1", interactionId: "i-1", stateRevision: 3, actionId: "reply" },
		]
		for (const candidate of scenarios) {
			const legacyResult = reduceInteraction(legacy, candidate)
			const kernelResult = transition(state, {
				...response(candidate.stateRevision),
				taskId: candidate.taskId,
				draftRef: candidate.draft ? "draft:1" : undefined,
			})
			expect(kernelResult.kind === "accepted").toBe(legacyResult.accepted)
		}
	})

	it("accepts the opening revision after unrelated revisions and rejects duplicate responses", () => {
		let state = openQuestion(runningState())
		state = accepted(
			transition(state, { type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "payload:1" }),
		).state
		const first = accepted(transition(state, response(1)))
		expect(first.state.dialog.primary).toMatchObject({ status: "resolving", acceptedResponse: { actionId: "reply" } })
		const duplicate = transition(first.state, response(first.state.revision))
		expect(duplicate).toMatchObject({ kind: "rejected", reason: "duplicate" })
		expect(duplicate.state).toBe(first.state)
	})

	it("restores the interrupted interaction atomically when the interrupt resolves", () => {
		let state = openQuestion(runningState(), "primary")
		state = accepted(
			transition(state, {
				type: "dialog.interrupt_requested",
				generation: 0,
				interactionId: "interrupt",
				turnId: "turn-1",
				kind: "condense",
				presentationRef: "condense:1",
				actionRules: [{ actionId: "confirm_utility", payloadPolicy: "none" }],
			}),
		).state
		expect(state.dialog.interrupted?.interactionId).toBe("primary")
		state = accepted(
			transition(state, {
				type: "dialog.prepared",
				generation: 0,
				interactionId: "interrupt",
				journalRef: "journal:0:2",
				receiverGeneration: 7,
			}),
		).state
		state = accepted(transition(state, { type: "dialog.presented", generation: 0, interactionId: "interrupt" })).state
		state = accepted(
			transition(state, {
				...response(state.revision, "interrupt"),
				actionId: "confirm_utility",
				draftRef: undefined,
			}),
		).state
		state = accepted(transition(state, { type: "dialog.resolved", generation: 0, interactionId: "interrupt" })).state
		expect(state.dialog.primary).toMatchObject({ interactionId: "primary", status: "awaiting" })
		expect(state.dialog.interrupted).toBeUndefined()
	})
})
