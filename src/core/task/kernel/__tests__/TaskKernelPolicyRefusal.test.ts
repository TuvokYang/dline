import { describe, expect, it } from "vitest"
import { transition } from "../transition"
import type { TaskState, TransitionResult } from "../types"
import { createInitialTaskState } from "../types"

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
	expect(result.kind).toBe("accepted")
	if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
	return result
}

function pendingPolicyTurn(): TaskState {
	return {
		...createInitialTaskState("task-1"),
		flow: { phase: "running" },
		turn: {
			turnId: "turn-1",
			mode: "serial",
			blocks: [
				{
					blockId: "b1",
					index: 0,
					phase: "pending" as const,
					attempt: "attempt:b1",
					invocationRef: "invocation:b1",
					lanes: [],
					turnEnding: false,
				},
			],
			manualApprovalBlockIds: [],
			automaticApprovalBlockIds: [],
			executingBlockIds: [],
		},
	}
}

function requestPolicy(state: TaskState): TaskState {
	return accepted(
		transition(state, {
			type: "approval.evaluation_requested",
			generation: 0,
			turnId: "turn-1",
			blockId: "b1",
			interactionId: "policy:b1",
			policyRevision: 1,
			riskFacts: { toolName: "execute_command" },
			attempt: "attempt:b1",
		}),
	).state
}

function evaluate(state: TaskState, approved: boolean): Extract<TransitionResult, { kind: "accepted" }> {
	const policy = state.turn.blocks[0].policy
	if (!policy) throw new Error("expected a policy owner on the pending block")
	return accepted(
		transition(state, {
			type: "approval.evaluated",
			generation: 0,
			commandId: policy.commandId,
			originRevision: policy.originRevision,
			interactionId: policy.interactionId,
			policyRevision: policy.policyRevision,
			blockId: "b1",
			attempt: "attempt:b1",
			approved,
		}),
	)
}

describe("task kernel policy refusal", () => {
	it("releases the flow when the policy refuses the last block", () => {
		const refused = evaluate(requestPolicy(pendingPolicyTurn()), false)

		expect(refused.state.turn.blocks[0].phase).toBe("rejected")
		// Without this the turn keeps every block terminal while the flow stays
		// "running": no further command is ever derived, so the task stops with no
		// error and no interaction the user could answer.
		expect(refused.state.flow.phase).toBe("waiting")
	})

	it("cascades a serial policy refusal to every later unstarted block", () => {
		const state = pendingPolicyTurn()
		const refused = evaluate(
			requestPolicy({
				...state,
				turn: {
					...state.turn,
					blocks: [
						...state.turn.blocks,
						{
							blockId: "b2",
							index: 1,
							phase: "pending",
							attempt: "attempt:b2",
							invocationRef: "invocation:b2",
							lanes: [],
							turnEnding: false,
						},
					],
				},
			}),
			false,
		)

		expect(refused.state.turn.blocks.map((block) => block.phase)).toEqual(["rejected", "skipped"])
		expect(refused.state.flow.phase).toBe("waiting")
	})

	it("keeps the flow running when the policy approves, because the block still has to execute", () => {
		const approved = evaluate(requestPolicy(pendingPolicyTurn()), true)

		expect(approved.state.turn.blocks[0].phase).toBe("ready")
		expect(approved.state.flow.phase).toBe("running")
		expect(approved.commands.map((command) => command.type)).toContain("tool.run")
	})
})
