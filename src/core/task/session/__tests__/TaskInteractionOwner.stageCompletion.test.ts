import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState, type TaskEvent, type TaskState, transition } from "../../kernel"
import type { MessageStateHandler } from "../../message-state"
import type { TaskPayloadStore } from "../../stores"
import { interactionId, interactionTurnId } from "../../tools/types/TaskConfig"
import type { ActiveTaskSession } from "../ActiveTaskSession"
import { TaskInteractionOwner } from "../TaskInteractionOwner"

const DLINE_TID = "dline_tid_01M48Z4EEYENAF5Y9BXJ7TMM6S"
/** The kernel names a turn after the compose command that produced it, not after a tool call. */
const KERNEL_TURN_ID = "turn:1791302448955:2:0"

function executingCompletionTurn(blockId = DLINE_TID): TaskState {
	return {
		...createInitialTaskState("1791302448955"),
		flow: { phase: "running" },
		turn: {
			turnId: KERNEL_TURN_ID,
			mode: "serial",
			blocks: [
				{
					blockId,
					index: 0,
					phase: "executing",
					attempt: "attempt-1",
					invocationRef: `invocation:${blockId}`,
					lanes: ["user-interaction"],
					turnEnding: true,
				},
			],
			manualApprovalBlockIds: [],
			automaticApprovalBlockIds: [blockId],
			executingBlockIds: [blockId],
		},
	}
}

/** An owner bound to a session whose runtime applies events through the real kernel. */
function createKernelBackedOwner(initial: TaskState) {
	let state = initial
	const submitted: string[] = []
	const apply = (event: TaskEvent) => {
		const result = transition(state, event)
		if (result.kind === "accepted") state = result.state
		return result
	}
	const session = {
		state: () => state,
		assembly: {
			runtime: {
				submit: async (event: TaskEvent) => {
					submitted.push(event.type)
					return apply(event)
				},
			},
		},
	} as unknown as ActiveTaskSession
	const owner = new TaskInteractionOwner(
		{ clineMessages: [] } as unknown as MessageStateHandler,
		{ put: vi.fn(async () => "sha256:presentation"), read: vi.fn() } as unknown as TaskPayloadStore,
	)
	owner.bind(session)
	const terminate = () => {
		apply({ type: "user.terminate", generation: state.generation, haltId: "close-1" })
		const pending = state.halt.status === "stopping" ? [...state.halt.pending] : []
		for (const participantId of pending)
			apply({ type: "halt.halted", generation: state.generation, haltId: "close-1", participantId })
	}
	return { owner, submitted, terminate, state: () => state }
}

/** The request AttemptCompletionHandler builds from the tool call. */
function completionRequest(dlineTid: string) {
	const block = { dline_tid: dlineTid }
	return {
		turnId: interactionTurnId(block),
		interactionId: interactionId(block),
		completionId: interactionId(block),
		presentation: "E2E_MULTI_WINDOW_PANEL_READY",
		existingTs: 123,
	}
}

describe("TaskInteractionOwner.stageCompletion", () => {
	it("keeps a shown completion when the task is closed before its dialog is requested", async () => {
		const harness = createKernelBackedOwner(executingCompletionTurn())

		await harness.owner.stageCompletion(completionRequest(DLINE_TID))
		harness.terminate()

		expect(harness.submitted).toEqual(["tool.completion_presented"])
		const state = harness.state()
		expect(state.flow.phase).toBe("terminated")
		expect(state.turn.blocks[0]?.phase).toBe("cancelled")
		expect(state.dialog.primary).toMatchObject({
			kind: "completion",
			interactionId: DLINE_TID,
			turnId: KERNEL_TURN_ID,
			status: "planned",
			presentationRef: "sha256:presentation",
		})
	})

	it("stages nothing for a completion whose block is not in the active turn", async () => {
		const harness = createKernelBackedOwner(executingCompletionTurn("dline_tid_other"))

		await harness.owner.stageCompletion(completionRequest(DLINE_TID))
		harness.terminate()

		expect(harness.submitted).toEqual([])
		expect(harness.state().dialog.primary).toBeUndefined()
	})
})
