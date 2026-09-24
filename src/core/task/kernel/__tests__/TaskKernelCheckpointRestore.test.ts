import { describe, expect, it } from "vitest"
import { hydrate } from "../hydrate"
import type { DialogInteraction, TaskState } from "../types"

const TASK_ID = "task-restore"

function completion(): DialogInteraction {
	return {
		interactionId: "completed:task-restore:20",
		turnId: "turn-4",
		kind: "completion",
		status: "awaiting",
		createdRevision: 20,
		presentationRef: "completion:done-1",
		actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
		journalRef: "journal:0:12",
	}
}

/** A task that finished after its conversation was compacted, as a restore finds it. */
function completedSnapshot(): TaskState {
	return {
		taskId: TASK_ID,
		revision: 20,
		generation: 2,
		flow: { phase: "completed", completionId: "done-1" },
		turn: {
			turnId: "turn-4",
			mode: "serial",
			blocks: [
				{
					blockId: "block-1",
					index: 0,
					phase: "completed",
					attempt: "attempt-1",
					lanes: [],
					turnEnding: true,
					invocationRef: "invocation-1",
				},
			],
			manualApprovalBlockIds: ["block-1"],
			automaticApprovalBlockIds: [],
			executingBlockIds: [],
		},
		dialog: {
			primary: completion(),
			approvalsByBlock: { "block-1": { ...completion(), interactionId: "approval-1", kind: "approval" } },
		},
		intake: { queued: [], background: [], coTask: [] },
		halt: { status: "idle", generation: 2 },
		journalWatermark: { epoch: 0, seq: 12 },
	}
}

describe("hydrate for a checkpoint restore", () => {
	it("plans a resume from the restored point instead of the discarded completion", () => {
		const result = hydrate({
			taskId: TASK_ID,
			snapshot: completedSnapshot(),
			journalTail: { epoch: 0, seq: 14 },
			openReason: "checkpoint_restore",
		})

		expect(result.kind).toBe("ready")
		if (result.kind !== "ready") return
		expect(result.form).toBe("interrupted")
		expect(result.state.flow.phase).toBe("paused")
		expect(result.state.dialog.primary).toMatchObject({ kind: "resume", status: "planned" })
		expect(result.state.dialog.approvalsByBlock).toEqual({})
		expect(result.state.turn.blocks).toEqual([])
		expect(result.state.turn.manualApprovalBlockIds).toEqual([])
		expect(result.initialCommands.map((command) => command.type)).toEqual(["dialog.prepare"])
	})

	it("keeps an ordinary resume of the same task on its completion dialog", () => {
		const result = hydrate({
			taskId: TASK_ID,
			snapshot: completedSnapshot(),
			journalTail: { epoch: 0, seq: 14 },
			openReason: "resume",
		})

		expect(result.kind).toBe("ready")
		if (result.kind !== "ready") return
		expect(result.form).toBe("completed")
		expect(result.state.dialog.primary?.kind).toBe("completion")
	})

	it("leaves a consumed task consumed, because a restore does not take back the handoff", () => {
		const consumed: TaskState = {
			...completedSnapshot(),
			flow: { phase: "terminated", terminalReason: "consumed", consumedRef: "successor-1" },
		}

		const result = hydrate({
			taskId: TASK_ID,
			snapshot: consumed,
			journalTail: { epoch: 0, seq: 14 },
			openReason: "checkpoint_restore",
		})

		expect(result.kind).toBe("ready")
		if (result.kind !== "ready") return
		expect(result.form).toBe("consumed")
		expect(result.initialCommands).toEqual([])
	})
})
