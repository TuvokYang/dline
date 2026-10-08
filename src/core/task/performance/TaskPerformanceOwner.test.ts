import { afterEach, describe, expect, it, vi } from "vitest"
import type { TaskState } from "../kernel"
import { ApiRequestRoundLifecycle } from "./api-request-round-lifecycle"
import type { ProviderRequestRoundAdmission } from "./provider-request-round-port"
import { TaskPerformanceOwner } from "./TaskPerformanceOwner"
import { TaskProviderRequestRoundOwner } from "./TaskProviderRequestRoundOwner"
import { TaskApiRateMetricsService } from "./task-api-rate-metrics-service"

function committedIn(phase: TaskState["flow"]["phase"], turnId = "turn-1"): TaskState {
	return { flow: { phase }, turn: { turnId, blocks: [] }, halt: { status: "idle" } } as unknown as TaskState
}

function stubPersistence(): void {
	vi.spyOn(TaskApiRateMetricsService.prototype, "initialize").mockResolvedValue(undefined)
	vi.spyOn(TaskApiRateMetricsService.prototype, "dispose").mockResolvedValue(undefined)
	vi.spyOn(ApiRequestRoundLifecycle.prototype, "initialize").mockResolvedValue(undefined)
	vi.spyOn(ApiRequestRoundLifecycle.prototype, "close").mockResolvedValue(undefined)
}

async function* empty(): AsyncGenerator<never> {}

describe("TaskPerformanceOwner", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	// Dev only accrued active seconds while its task loop ran, so a task that
	// waits on the user or comes to rest stops adding to its rates.
	it("follows the committed task loop for active-time accrual", async () => {
		stubPersistence()
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

	// The header's RPM is the rate of logical requests: a turn's retries are one
	// request, and the request counts once the turn stops running.
	it("admits one logical round per turn and completes it when the turn stops running", async () => {
		stubPersistence()
		const admission = {
			bindAttempt: <T>(stream: AsyncIterable<T>) => stream,
		} as unknown as ProviderRequestRoundAdmission
		const admit = vi.spyOn(TaskProviderRequestRoundOwner.prototype, "admitOrdinary").mockReturnValue(admission)
		vi.spyOn(TaskProviderRequestRoundOwner.prototype, "getOrdinary").mockReturnValue(admission)
		const complete = vi.spyOn(TaskProviderRequestRoundOwner.prototype, "completeTurn").mockReturnValue(undefined)
		const usage = vi.spyOn(TaskProviderRequestRoundOwner.prototype, "attachOrdinaryExactUsage").mockReturnValue(undefined)
		const rateUsage = vi.spyOn(TaskApiRateMetricsService.prototype, "recordExactUsage").mockReturnValue(undefined)
		const owner = await TaskPerformanceOwner.open({
			taskId: "task-1",
			readState: () => committedIn("idle"),
			legacyMessages: () => [],
		})

		owner.bindOrdinaryAttempt("turn-a", 0, empty())
		owner.bindOrdinaryAttempt("turn-a", 1, empty())
		owner.requestSettled({ inputTokens: 10, outputTokens: 2 }, "turn-a")
		owner.committed(committedIn("running", "turn-a"))
		expect(complete).not.toHaveBeenCalled()

		owner.committed(committedIn("waiting", "turn-a"))
		owner.committed(committedIn("waiting", "turn-a"))
		// A later request streams before the state names its turn, and stays open.
		owner.bindOrdinaryAttempt("turn-b", 0, empty())
		owner.committed(committedIn("running", "turn-a"))
		expect(complete).toHaveBeenCalledTimes(1)
		// A completion offered to the user ends the run while the flow stays open.
		owner.committed(committedIn("running", "turn-b"), true)
		await owner.release()

		expect(admit.mock.calls).toEqual([
			[0, 0],
			[0, 1],
			[1, 0],
		])
		expect(complete).toHaveBeenCalledTimes(2)
		expect(usage).toHaveBeenCalledWith(
			0,
			expect.objectContaining({ inputTokens: 10, outputTokens: 2, cacheUsageReported: false }),
		)
		// TPM is a generation rate: the prompt read before streaming must not count toward it.
		expect(rateUsage.mock.calls).toEqual([[{ outputTokens: 2 }]])
	})
})
