import { describe, expect, it } from "vitest"
import { transition } from "../transition"
import type { ComposeRoundCommand, KernelBlock, TaskEvent, TaskState, TransitionResult } from "../types"
import { createInitialTaskState } from "../types"

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
	expect(result.kind).toBe("accepted")
	if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
	return result
}

function block(blockId: string, index: number, phase: KernelBlock["phase"]): KernelBlock {
	return {
		blockId,
		index,
		phase,
		attempt: `attempt-${blockId}`,
		invocationRef: `invocation:${blockId}`,
		lanes: [],
		turnEnding: false,
	}
}

/** A parallel turn whose `awaiting` block holds an answered approval the shell is about to settle. */
function awaitingRefusal(blocks: readonly KernelBlock[], awaiting = "b1"): TaskState {
	return {
		...createInitialTaskState("task-1"),
		flow: { phase: "running" },
		turn: {
			turnId: "turn-1",
			mode: "parallel",
			blocks,
			manualApprovalBlockIds: [awaiting],
			automaticApprovalBlockIds: [],
			executingBlockIds: blocks
				.filter((candidate) => candidate.phase === "executing")
				.map((candidate) => candidate.blockId),
		},
		dialog: {
			approvalsByBlock: {
				[awaiting]: {
					interactionId: `approval:${awaiting}`,
					turnId: "turn-1",
					kind: "tool_approval",
					status: "resolving",
					createdRevision: 0,
					presentationRef: `approval:${awaiting}`,
					actionRules: [
						{ actionId: "approve", payloadPolicy: "draft" },
						{ actionId: "reject", payloadPolicy: "draft" },
					],
					acceptedResponse: { actionId: "reject", stateRevision: 0, receiverGeneration: 0 },
					blockId: awaiting,
					receiverGeneration: 0,
				},
			},
		},
	}
}

function refuse(blockId = "b1", feedbackRef?: string): TaskEvent {
	return {
		type: "approval.responded",
		generation: 0,
		turnId: "turn-1",
		blockId,
		interactionId: `approval:${blockId}`,
		approved: false,
		...(feedbackRef === undefined ? {} : { feedbackRef }),
	} as TaskEvent
}

function settle(blockId: string): TaskEvent {
	return { type: "tool.completed", generation: 0, turnId: "turn-1", blockId, attempt: `attempt-${blockId}` } as TaskEvent
}

function composeOf(result: Extract<TransitionResult, { kind: "accepted" }>): ComposeRoundCommand {
	const compose = result.commands.find((command): command is ComposeRoundCommand => command.type === "compose.round")
	if (!compose) throw new Error("expected compose.round")
	return compose
}

describe("task kernel human refusal", () => {
	it("continues the turn once when the user refuses the last open block after its siblings finished", () => {
		const result = accepted(
			transition(
				awaitingRefusal([block("b0", 0, "completed"), block("b1", 1, "awaiting_approval"), block("b2", 2, "completed")]),
				refuse("b1", "feedback:b1"),
			),
		)

		expect(result.commands.map((command) => command.type)).toEqual(["tool.retire", "compose.round"])
		expect(composeOf(result).toolTerminals).toEqual({
			turnId: "turn-1",
			blocks: [
				{ blockId: "b0", phase: "completed", invocationRef: "invocation:b0" },
				{
					blockId: "b1",
					phase: "rejected",
					invocationRef: "invocation:b1",
					approvalFeedbackRef: "feedback:b1",
					deniedByUser: true,
				},
				{ blockId: "b2", phase: "completed", invocationRef: "invocation:b2" },
			],
		})
		expect(result.state.flow.phase).toBe("running")
		expect(result.state.flow.compose?.status).toBe("running")
	})

	it("continues a single refused block exactly once", () => {
		const result = accepted(transition(awaitingRefusal([block("b1", 0, "awaiting_approval")]), refuse()))

		expect(result.commands.filter((command) => command.type === "compose.round")).toHaveLength(1)
		expect(result.state.flow.phase).toBe("running")
	})

	it("leaves the continuation to the last executing sibling and composes only when it settles", () => {
		const refused = accepted(
			transition(
				awaitingRefusal([block("b0", 0, "executing"), block("b1", 1, "awaiting_approval"), block("b2", 2, "executing")]),
				refuse(),
			),
		)
		expect(refused.commands).toEqual([])
		expect(refused.state.flow.phase).toBe("running")

		const first = accepted(transition(refused.state, settle("b0")))
		expect(first.commands).toEqual([])

		const last = accepted(transition(first.state, settle("b2")))
		expect(last.commands.map((command) => command.type)).toEqual(["tool.retire", "compose.round"])
		expect(composeOf(last).toolTerminals?.blocks.find((entry) => entry.blockId === "b1")).toMatchObject({
			phase: "rejected",
			deniedByUser: true,
		})
	})

	it("skips a later ready sibling and still composes only once", () => {
		const result = accepted(
			transition(
				awaitingRefusal([block("b0", 0, "completed"), block("b1", 1, "awaiting_approval"), block("b2", 2, "ready")]),
				refuse(),
			),
		)

		expect(result.state.turn.blocks.find((candidate) => candidate.blockId === "b2")?.phase).toBe("skipped")
		expect(result.commands.filter((command) => command.type === "compose.round")).toHaveLength(1)
		expect(transition(result.state, settle("b2")).kind).toBe("rejected")
	})

	it("only retires the turn while the task is stopping, and releases the flow to the user", () => {
		const stopping: TaskState = {
			...awaitingRefusal([block("b0", 0, "completed"), block("b1", 1, "awaiting_approval")]),
			// A participant still has to acknowledge the stop, so the halt stays open.
			halt: { status: "stopping", generation: 0, target: "paused", pending: ["provider"] } as unknown as TaskState["halt"],
		}

		const result = accepted(transition(stopping, refuse()))

		expect(result.commands.map((command) => command.type)).toEqual(["tool.retire"])
		expect(result.state.flow.phase).toBe("waiting")
	})
})
