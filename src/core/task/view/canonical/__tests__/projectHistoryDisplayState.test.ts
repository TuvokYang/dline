import { describe, expect, it } from "vitest"
import { createInitialTaskState, type TaskState } from "../../../kernel"
import { projectHistoryDisplayState } from "../projectHistoryDisplayState"

function consumedSnapshot(): TaskState {
	const initial = createInitialTaskState("task-1")
	return {
		...initial,
		revision: 7,
		flow: { ...initial.flow, phase: "terminated", terminalReason: "consumed", consumedRef: "new_task:function-1:tid-1" },
		dialog: { approvalsByBlock: {} },
	}
}

describe("projectHistoryDisplayState", () => {
	it("offers nothing to resume or answer for a task its successor consumed", () => {
		const projection = projectHistoryDisplayState("task-1", consumedSnapshot())

		expect(projection.synthetic).toBeUndefined()
		expect(projection.state.dialog.primary).toBeUndefined()
		expect(projection.state.dialog.approvalsByBlock).toEqual({})
		expect(projection.state.flow).toMatchObject({ phase: "terminated", terminalReason: "consumed" })
	})

	it("still offers Resume for a task that stopped mid-run", () => {
		const initial = createInitialTaskState("task-1")
		const stopped: TaskState = { ...initial, revision: 3, flow: { ...initial.flow, phase: "terminated" } }

		const projection = projectHistoryDisplayState("task-1", stopped)

		expect(projection.state.dialog.primary).toMatchObject({ kind: "resume", status: "awaiting" })
	})
})
