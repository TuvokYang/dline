import { Task } from "@core/task"
import { describe, expect, it, vi } from "vitest"

/** Verify task-local mode access and atomic commit ordering without constructing runtime services. */
describe("Task task-local mode", () => {
	/** Keep mode reads isolated to each task state manager. */
	it("reads independent task-local modes", () => {
		const planTask = { taskSm: { mode: "plan" } }
		const actTask = { taskSm: { mode: "act" } }

		expect(Task.prototype.getMode.call(planTask)).toBe("plan")
		expect(Task.prototype.getMode.call(actTask)).toBe("act")
	})

	/** Commit mode before rebuilding, causally continuing the interaction, and flushing persistence. */
	it("commits in atomic runtime order", async () => {
		const order: string[] = []
		const fakeTask = {
			taskSm: { mode: "plan", setMode: vi.fn(() => order.push("mode")) },
			rebuildApiHandler: vi.fn(() => order.push("rebuild")),
			taskState: { isAwaitingPlanResponse: true, didRespondToPlanAskBySwitchingMode: false },
			interactionCoordinator: {
				canRespondForModeSwitch: vi.fn(() => true),
				respondForModeSwitch: vi.fn(async () => {
					order.push("wake")
					return true
				}),
			},
			stateManager: {
				flushPendingState: vi.fn(async () => {
					order.push("flush")
				}),
			},
		}

		await Task.prototype.commitMode.call(fakeTask, "act", {
			message: "continue",
			images: ["image"],
			files: ["file"],
		})

		expect(order).toEqual(["mode", "rebuild", "wake", "flush"])
		expect(fakeTask.interactionCoordinator.respondForModeSwitch).toHaveBeenCalledWith({
			text: "continue",
			images: ["image"],
			files: ["file"],
		})
		expect(fakeTask.taskState.didRespondToPlanAskBySwitchingMode).toBe(true)
	})

	/** Switch modes without resolving the awaiting interaction when no user-authored input exists. */
	it("does not continue an awaiting interaction without input", async () => {
		const fakeTask = {
			taskSm: { mode: "act", setMode: vi.fn() },
			rebuildApiHandler: vi.fn(),
			taskState: { isAwaitingPlanResponse: true, didRespondToPlanAskBySwitchingMode: true },
			interactionCoordinator: {
				canRespondForModeSwitch: vi.fn(() => true),
				respondForModeSwitch: vi.fn(async () => true),
			},
			stateManager: { flushPendingState: vi.fn(async () => undefined) },
		}

		await Task.prototype.commitMode.call(fakeTask, "plan")

		expect(fakeTask.taskSm.setMode).toHaveBeenCalledWith("plan")
		expect(fakeTask.rebuildApiHandler).toHaveBeenCalledOnce()
		expect(fakeTask.interactionCoordinator.canRespondForModeSwitch).not.toHaveBeenCalled()
		expect(fakeTask.interactionCoordinator.respondForModeSwitch).not.toHaveBeenCalled()
		expect(fakeTask.taskState.didRespondToPlanAskBySwitchingMode).toBe(false)
		expect(fakeTask.stateManager.flushPendingState).toHaveBeenCalledOnce()
	})

	/** Restore the source mode if the awaiting interaction changes before its causal response is accepted. */
	it("rolls back a rejected plan continuation", async () => {
		const taskSm = {
			mode: "plan",
			setMode: vi.fn((mode: "plan" | "act") => {
				taskSm.mode = mode
			}),
		}
		const fakeTask = {
			taskSm,
			rebuildApiHandler: vi.fn(),
			taskState: { isAwaitingPlanResponse: true, didRespondToPlanAskBySwitchingMode: false },
			interactionCoordinator: {
				canRespondForModeSwitch: vi.fn(() => true),
				respondForModeSwitch: vi.fn(async () => false),
			},
			stateManager: { flushPendingState: vi.fn() },
		}

		await expect(
			Task.prototype.commitMode.call(fakeTask, "act", { message: "continue", images: [], files: [] }),
		).rejects.toThrow("The active plan interaction changed during the mode switch.")

		expect(taskSm.mode).toBe("plan")
		expect(taskSm.setMode).toHaveBeenNthCalledWith(1, "act")
		expect(taskSm.setMode).toHaveBeenNthCalledWith(2, "plan")
		expect(fakeTask.rebuildApiHandler).toHaveBeenCalledTimes(2)
		expect(fakeTask.taskState.didRespondToPlanAskBySwitchingMode).toBe(false)
		expect(fakeTask.stateManager.flushPendingState).not.toHaveBeenCalled()
	})
})
