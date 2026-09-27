import { describe, expect, it } from "vitest"
import { hydrate } from "../hydrate"
import { transition } from "../transition"
import type { KernelBlock, TaskEvent, TaskState, TransitionResult } from "../types"
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
		attempt: `attempt:${blockId}`,
		invocationRef: `invocation:${blockId}`,
		lanes: [],
		turnEnding: blockId === "new-task",
	}
}

/** A turn whose `new_task` block is running, with work before and after it. */
function handingOff(): TaskState {
	return {
		...createInitialTaskState("task-1"),
		revision: 7,
		flow: { phase: "running" },
		turn: {
			turnId: "turn-1",
			mode: "serial",
			blocks: [block("read", 0, "completed"), block("new-task", 1, "executing"), block("later", 2, "ready")],
			manualApprovalBlockIds: [],
			automaticApprovalBlockIds: [],
			executingBlockIds: ["new-task"],
		},
	}
}

const consumed: TaskEvent = {
	type: "lifecycle.consumed",
	generation: 0,
	turnId: "turn-1",
	blockId: "new-task",
	consumedRef: "new_task:function-1:new-task",
}

describe("task kernel successor handoff", () => {
	it("terminates the source as consumed without deriving any further work", () => {
		const result = accepted(transition(handingOff(), consumed))

		expect(result.state.flow).toMatchObject({
			phase: "terminated",
			terminalReason: "consumed",
			consumedRef: "new_task:function-1:new-task",
		})
		expect(result.commands).toEqual([])
		expect(result.state.dialog).toEqual({ approvalsByBlock: {} })
		expect(result.state.turn.blocks.map((candidate) => [candidate.blockId, candidate.phase])).toEqual([
			["read", "completed"],
			["new-task", "completed"],
			["later", "skipped"],
		])
		expect(result.state.turn.executingBlockIds).toEqual([])
	})

	it("refuses the consuming block's own completion, so no round is opened for the successor's conversation", () => {
		const state = accepted(transition(handingOff(), consumed)).state

		const completion = transition(state, {
			type: "tool.completed",
			generation: 0,
			attempt: "attempt:new-task",
			turnId: "turn-1",
			blockId: "new-task",
		})

		expect(completion).toMatchObject({ kind: "rejected", reason: "phase_invalid" })
		expect(completion.state).toBe(state)
	})

	it("refuses a later stop, so tearing the source down never waits on a halt", () => {
		const state = accepted(transition(handingOff(), consumed)).state

		expect(transition(state, { type: "user.terminate", generation: 0, haltId: "halt-1" })).toMatchObject({
			kind: "rejected",
			reason: "phase_invalid",
		})
	})

	it.each([
		["a block that is not running", { blockId: "later" }, "phase_invalid"],
		["a block outside the turn", { blockId: "unknown" }, "identity_mismatch"],
		["a stale turn", { turnId: "turn-0" }, "identity_mismatch"],
		["a handoff without identity", { consumedRef: "" }, "identity_mismatch"],
	] as const)("refuses a handoff from %s", (_name, override, reason) => {
		const state = handingOff()
		const result = transition(state, { ...consumed, ...override } as TaskEvent)

		expect(result).toMatchObject({ kind: "rejected", reason })
		expect(result.state).toBe(state)
	})

	it("refuses a handoff while the task is already stopping, because the user stopped it first", () => {
		const state: TaskState = {
			...handingOff(),
			halt: {
				status: "stopping",
				haltId: "halt-1",
				generation: 0,
				target: "paused",
				pending: ["tool"],
				halted: [],
				failed: [],
				timedOut: [],
			},
		}

		expect(transition(state, consumed)).toMatchObject({ kind: "rejected", reason: "phase_invalid" })
	})

	it("reopens the consumed source inert", () => {
		const state = accepted(transition(handingOff(), consumed)).state

		const reopened = hydrate({ taskId: "task-1", snapshot: state, journalTail: { seq: 0 }, openReason: "resume" })

		expect(reopened).toMatchObject({ kind: "ready", form: "consumed" })
		if (reopened.kind !== "ready") throw new Error("expected a hydrated task")
		expect(reopened.initialCommands).toEqual([])
		expect(reopened.state.dialog.primary).toBeUndefined()
	})
})
