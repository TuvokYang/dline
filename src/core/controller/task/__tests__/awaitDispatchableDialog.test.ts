import { createInitialTaskState, type TaskState } from "@core/task/kernel"
import { describe, expect, it } from "vitest"
import { awaitDispatchableDialog } from "../awaitDispatchableDialog"

function planned(halt: TaskState["halt"] = { status: "idle", generation: 0 }): TaskState {
	return {
		...createInitialTaskState("task-1"),
		halt,
		dialog: {
			approvalsByBlock: {},
			interrupted: {
				interactionId: "recovery-1",
				turnId: "turn-1",
				kind: "resume_task",
				status: "planned",
				createdRevision: 4,
				presentationRef: "presentation-1",
				actionRules: [{ actionId: "resume", payloadPolicy: "none" }],
			},
		},
	} as TaskState
}

function answerable(): TaskState {
	const state = planned()
	return {
		...state,
		dialog: { ...state.dialog, interrupted: { ...state.dialog.interrupted!, status: "awaiting", receiverGeneration: 0 } },
	} as TaskState
}

/** Bounded well below the default wait, so an early exit is distinguishable from a timeout. */
const LONG_WAIT_MS = 5_000

describe("awaitDispatchableDialog", () => {
	it("returns the recovery dialog once its reveal makes it answerable", async () => {
		let current = planned()
		setTimeout(() => {
			current = answerable()
		}, 30)

		const dialog = await awaitDispatchableDialog({ state: () => current }, { timeoutMs: LONG_WAIT_MS })

		expect(dialog?.interactionId).toBe("recovery-1")
	})

	it("stops waiting as soon as the task starts stopping", async () => {
		const started = Date.now()

		const dialog = await awaitDispatchableDialog(
			{ state: () => planned({ status: "stopping", generation: 1 } as TaskState["halt"]) },
			{ timeoutMs: LONG_WAIT_MS },
		)

		expect(dialog).toBeUndefined()
		expect(Date.now() - started).toBeLessThan(1_000)
	})

	it("stops waiting once the caller no longer serves the task", async () => {
		let current = true
		setTimeout(() => {
			current = false
		}, 30)
		const started = Date.now()

		const dialog = await awaitDispatchableDialog(
			{ state: () => planned() },
			{ timeoutMs: LONG_WAIT_MS, isCurrent: () => current },
		)

		expect(dialog).toBeUndefined()
		expect(Date.now() - started).toBeLessThan(1_000)
	})
})
