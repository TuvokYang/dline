import type { CheckpointRestoreFence } from "@core/task/session/ActiveTaskSession"
import { describe, expect, it, vi } from "vitest"
import { Controller } from "../index"

function subject(taskIncarnationId = "incarnation-1") {
	const clearTask = vi.fn(async () => undefined)
	const initTask = vi.fn(async () => undefined)
	const controller = {
		task: {
			taskId: "task-1",
			owners: { identity: { taskId: "task-1", taskIncarnationId } },
		},
		runTaskLifecycleOperation: vi.fn(async (operation) => operation({ clearTask })),
		getTaskWithId: vi.fn(async () => ({ historyItem: { id: "task-1" } })),
		initTask,
	}
	return { controller, clearTask, initTask }
}

describe("Controller checkpoint restore lifecycle", () => {
	it("releases the fenced incarnation and reopens without a second clear", async () => {
		const { controller, clearTask, initTask } = subject()
		const fence = { taskId: "task-1", taskIncarnationId: "incarnation-1", haltId: "restore-1" } as CheckpointRestoreFence

		await Controller.prototype.reopenTaskForCheckpointRestore.call(controller as never, "task-1", fence)

		expect(clearTask).toHaveBeenCalledExactlyOnceWith({
			suppressPostState: true,
			checkpointRestoreFence: fence,
		})
		expect(initTask).toHaveBeenCalledWith(undefined, undefined, undefined, { id: "task-1" }, undefined, {
			activateHistory: true,
			openReason: "checkpoint_restore",
			skipInitialClear: true,
		})
	})

	it("refuses a fence issued by a different task incarnation", async () => {
		const { controller, clearTask, initTask } = subject("incarnation-current")
		const fence = { taskId: "task-1", taskIncarnationId: "incarnation-stale", haltId: "restore-1" } as CheckpointRestoreFence

		await expect(
			Controller.prototype.reopenTaskForCheckpointRestore.call(controller as never, "task-1", fence),
		).rejects.toThrow("Checkpoint restore session changed")
		expect(clearTask).not.toHaveBeenCalled()
		expect(initTask).not.toHaveBeenCalled()
	})
})
