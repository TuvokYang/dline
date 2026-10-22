import { Controller } from "@core/controller"
import { TaskTeardownRecovery } from "@core/controller/task/TaskTeardownRecovery"
import { OrchestratorController } from "@core/orchestrator/OrchestratorController"
import Mutex from "p-mutex"
import { describe, expect, it, vi } from "vitest"

/** Exercise the real close and lifecycle lane, isolating only transition/store ports. */
function closingController(dispose: () => Promise<void>) {
    const controller = Object.create(Controller.prototype) as Controller
    const task = {
        taskId: "task-1",
        taskInstanceId: "open-1",
        owners: { settings: { mode: "act" }, prompt: { beginDispose: vi.fn() } },
        beginClose: vi.fn(),
        dispose: vi.fn(dispose),
    }
    const releaseTaskLock = vi.fn(async () => undefined)
    OrchestratorController.initialize()
    Object.assign(controller, {
        task,
        taskLifecycleMutex: new Mutex(),
        taskTeardownRecovery: new TaskTeardownRecovery(),
        taskLockAcquired: true,
        lockPollGeneration: 0,
        lockTakeoverTimers: new Set(),
        stateManager: { setGlobalState: vi.fn(), clearTaskSettings: vi.fn(async () => undefined) },
        contextTransitionEngine: { reset: vi.fn(async () => undefined) },
        profileTransitionEngine: { reset: vi.fn(async () => undefined) },
        lockService: {
            instanceAddress: "test-instance",
            checkTaskLock: vi.fn(async () => ({ isLocked: true, lockedBy: "test-instance" })),
            releaseTaskLock,
        },
        restartAccountUsagePolling: vi.fn(),
    })
    vi.spyOn(controller, "postStateToWebview").mockResolvedValue(undefined)
    return { controller, task, releaseTaskLock }
}

describe("Controller Task opening fence", () => {
    it("retries a failed close drain before admitting a replacement writer", async () => {
        const failure = new Error("message store close failed")
        let attempts = 0
        const { controller, task, releaseTaskLock } = closingController(async () => {
            if (attempts++ === 0) throw failure
        })
        await expect(controller.clearTask()).rejects.toBe(failure)
        expect(controller.task).toBeUndefined()
        expect(task.beginClose).toHaveBeenCalledOnce()
        expect(releaseTaskLock).not.toHaveBeenCalled()

        const replacement = vi.fn(async () => "opened")
        await expect(controller.runTaskLifecycleOperation(replacement)).resolves.toBe("opened")
        expect(task.dispose).toHaveBeenCalledTimes(2)
        expect(releaseTaskLock).toHaveBeenCalledOnce()
        expect(replacement).toHaveBeenCalledOnce()
    })

    it("returns the fresh retry failure while keeping the replacement fenced", async () => {
        const failures = [new Error("first close failed"), new Error("retry still cannot write")]
        let attempts = 0
        const { controller, task, releaseTaskLock } = closingController(async () => {
            throw failures[attempts++]
        })
        await expect(controller.clearTask()).rejects.toBe(failures[0])

        const replacement = vi.fn(async () => "opened")
        await expect(controller.runTaskLifecycleOperation(replacement)).rejects.toBe(failures[1])
        expect(task.dispose).toHaveBeenCalledTimes(2)
        expect(releaseTaskLock).not.toHaveBeenCalled()
        expect(replacement).not.toHaveBeenCalled()
    })

    it("retries a failed deferred drain for an opening already waiting on it", async () => {
        let reject!: (error: Error) => void
        const drain = new Promise<void>((_resolve, fail) => {
            reject = fail
        })
        let attempts = 0
        const { controller, task, releaseTaskLock } = closingController(() => {
            attempts++
            return attempts === 1 ? drain : Promise.resolve()
        })
        await controller.clearTask({ deferTeardown: true })
        expect(controller.task).toBeUndefined()
        const replacement = vi.fn(async () => "opened")
        const opening = controller.runTaskLifecycleOperation(replacement)
        reject(new Error("deferred store close failed"))

        await expect(opening).resolves.toBe("opened")
        expect(task.dispose).toHaveBeenCalledTimes(2)
        expect(releaseTaskLock).toHaveBeenCalledOnce()
        expect(replacement).toHaveBeenCalledOnce()
    })

    it("keeps another Controller's lifecycle lane independent", async () => {
        const failure = new Error("task-a disk full")
        const taskA = closingController(async () => {
            throw failure
        })
        const taskB = closingController(async () => undefined)
        await expect(taskA.controller.clearTask()).rejects.toBe(failure)

        const otherTaskOperation = vi.fn(async () => "task-b-running")
        await expect(taskB.controller.runTaskLifecycleOperation(otherTaskOperation)).resolves.toBe("task-b-running")
        expect(otherTaskOperation).toHaveBeenCalledOnce()
    })
})
