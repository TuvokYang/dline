import { afterEach, describe, expect, it, vi } from "vitest"
import type { TaskState } from "../kernel"
import { ApiRequestRoundLifecycle } from "./api-request-round-lifecycle"
import { TaskPerformanceOwner } from "./TaskPerformanceOwner"
import { TaskApiRateMetricsService } from "./task-api-rate-metrics-service"

function committedIn(phase: TaskState["flow"]["phase"]): TaskState {
	return { flow: { phase } } as unknown as TaskState
}

describe("TaskPerformanceOwner", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	// Dev only accrued active seconds while its task loop ran, so a task that
	// waits on the user or comes to rest stops adding to its rates.
	it("follows the committed task loop for active-time accrual", async () => {
		vi.spyOn(TaskApiRateMetricsService.prototype, "initialize").mockResolvedValue(undefined)
		vi.spyOn(TaskApiRateMetricsService.prototype, "dispose").mockResolvedValue(undefined)
		vi.spyOn(ApiRequestRoundLifecycle.prototype, "initialize").mockResolvedValue(undefined)
		vi.spyOn(ApiRequestRoundLifecycle.prototype, "close").mockResolvedValue(undefined)
		const loop = vi.spyOn(TaskApiRateMetricsService.prototype, "setTaskLoopActive")
		const owner = await TaskPerformanceOwner.open({
			taskId: "task-1",
			readState: () => committedIn("idle"),
			legacyMessages: () => [],
		})

		for (const phase of ["initializing", "running", "waiting", "running", "completed", "paused"] as const) {
			owner.committed(committedIn(phase))
		}
		await owner.release()

		expect(loop.mock.calls.map(([active]) => active)).toEqual([true, true, false, true, false, false])
	})
})
