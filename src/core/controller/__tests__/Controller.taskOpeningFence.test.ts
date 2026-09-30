import { Controller } from "@core/controller"
import Mutex from "p-mutex"
import { describe, expect, it, vi } from "vitest"

/** Exercise the real close and lifecycle lane, isolating only transition/store ports. */
function closingController(terminate: () => Promise<void>) {
	const controller = Object.create(Controller.prototype) as Controller
	const task = {
		taskId: "task-1",
		taskInstanceId: "open-1",
		taskSm: { mode: "act" },
		fenceControllerDetachment: vi.fn(),
		terminate: vi.fn(terminate),
		isReadOnly: () => false,
	}
	const releaseTaskLock = vi.fn(async () => undefined)
	Object.assign(controller, {
		task,
		taskLifecycleMutex: new Mutex(),
		taskLockAcquired: true,
		lockPollGeneration: 0,
		lockTakeoverTimers: new Set(),
		stateManager: { setGlobalState: vi.fn(), clearTaskSettings: vi.fn(async () => undefined) },
		contextTransitionEngine: { reset: vi.fn(async () => undefined) },
		profileTransitionEngine: { reset: vi.fn(async () => undefined) },
		lockService: { releaseTaskLock },
		restartAccountUsagePolling: vi.fn(),
	})
	vi.spyOn(controller, "postStateToWebview").mockResolvedValue(undefined)
	return { controller, task, releaseTaskLock }
}

describe("Controller Task opening fence", () => {
	it("does not admit a replacement writer after a failed close drain", async () => {
		const failure = new Error("message store close failed")
		const { controller, task, releaseTaskLock } = closingController(async () => {
			throw failure
		})
		await expect(controller.clearTask()).rejects.toBe(failure)
		expect(controller.task).toBeUndefined()
		expect(task.fenceControllerDetachment).toHaveBeenCalledOnce()
		expect(releaseTaskLock).not.toHaveBeenCalled()
		const replacement = vi.fn(async () => "opened")
		await expect(controller.runTaskLifecycleOperation(replacement)).rejects.toBe(failure)
		expect(replacement).not.toHaveBeenCalled()
	})

	it("retains a failed deferred drain as the next opening's admission barrier", async () => {
		let reject!: (error: Error) => void
		const drain = new Promise<void>((_resolve, fail) => {
			reject = fail
		})
		const { controller } = closingController(() => drain)
		await controller.clearTask({ deferTeardown: true })
		expect(controller.task).toBeUndefined()
		const replacement = vi.fn(async () => "opened")
		const opening = controller.runTaskLifecycleOperation(replacement)
		const failure = new Error("deferred store close failed")
		reject(failure)
		await expect(opening).rejects.toBe(failure)
		expect(replacement).not.toHaveBeenCalled()
	})
})
