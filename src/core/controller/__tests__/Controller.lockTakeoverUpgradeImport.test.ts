import { beforeEach, describe, expect, it, vi } from "vitest"
import { TrajectoryAdmission } from "@/core/trajectory/TrajectorySource"
import { ShowMessageType } from "@/shared/proto/dline/host/window"
import { Controller } from "../index"
import { OpeningHandoff } from "../task/OpeningHandoff"

const host = vi.hoisted(() => ({ showMessage: vi.fn() }))

vi.mock("@/core/storage/disk", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/core/storage/disk")>()),
    cleanupStaleTaskTempFiles: vi.fn(async () => undefined),
}))

vi.mock("@/hosts/host-provider", () => ({ HostProvider: { window: { showMessage: host.showMessage } } }))

type TakeOver = (owner: unknown, scope: unknown) => Promise<void>

const prototype = Controller.prototype as unknown as {
    takeOverTaskAfterUnlock: TakeOver
    reopenForUpgradeImport: (taskId: string, scope: unknown) => Promise<void>
    rollbackUnownedOpening: (taskId: string, closeHistory: () => void) => Promise<void>
}

beforeEach(() => {
    vi.clearAllMocks()
})

/**
 * A window that opened the task without its lock, now taking it over.
 *
 * Only the members the takeover reads are present, so an unexpected path fails
 * loudly instead of passing against a stub.
 */
function subject(upgradeImportPending: boolean) {
    const owner = { taskId: "task-1" }
    const clearTask = vi.fn(async () => undefined)
    const open = vi.fn(async () => undefined)
    const controller = {
        disposed: false,
        taskLockAcquired: false,
        trajectoryAdmission: new TrajectoryAdmission(),
        historyDisplaySession: undefined,
        currentOpening: () => owner,
        task: {
            taskId: "task-1",
            upgradeImportPending,
            activateCollaboration: vi.fn(),
            task: { open },
            activateBackgroundIngress: vi.fn(async () => undefined),
        },
        lockService: { acquireTaskLock: vi.fn(async () => true) },
        stopLockPoll: vi.fn(),
        startLockHeartbeat: vi.fn(),
        openingHandoff: new OpeningHandoff(),
        postStateToWebview: vi.fn(async () => undefined),
        getTaskWithId: vi.fn(async () => ({ historyItem: { id: "task-1" } })),
        initTask: vi.fn(async () => undefined),
        reopenForUpgradeImport: prototype.reopenForUpgradeImport,
    }
    const takeOver = () => prototype.takeOverTaskAfterUnlock.call(controller, owner, { clearTask })
    return { controller, clearTask, open, takeOver }
}

describe("Controller lock takeover of a task with data from an earlier version", () => {
    // Opening in place would let the session's first journal write close the
    // import off for good, so the follow-up would be sent without the history.
    it("reopens the session so the import runs before the kernel reads the stores", async () => {
        const { controller, clearTask, open, takeOver } = subject(true)

        await takeOver()

        expect(clearTask).toHaveBeenCalledExactlyOnceWith({ suppressPostState: true, closeReason: "task_switch" })
        expect(controller.initTask).toHaveBeenCalledExactlyOnceWith(
            undefined,
            undefined,
            undefined,
            { id: "task-1" },
            undefined,
            {
                activateHistory: true,
                skipInitialClear: true,
            },
        )
        // initTask takes the lock itself; acquiring it here as well would leave
        // the reopened session racing its own lock file.
        expect(controller.lockService.acquireTaskLock).not.toHaveBeenCalled()
        expect(open).not.toHaveBeenCalled()
        expect(controller.taskLockAcquired).toBe(false)
    })

    // The takeover runs from a timer, so nothing else would tell the user why
    // the chat they were looking at emptied.
    it("tells the user when the reopen fails and leaves the failure to the caller", async () => {
        const { controller, takeOver } = subject(true)
        const failure = new Error("journal.db is read-only")
        controller.initTask.mockRejectedValue(failure)

        await expect(takeOver()).rejects.toBe(failure)

        expect(host.showMessage).toHaveBeenCalledExactlyOnceWith({
            type: ShowMessageType.ERROR,
            message: expect.stringContaining("journal.db is read-only"),
        })
        expect(controller.postStateToWebview).toHaveBeenCalledOnce()
    })

    // A history lookup that fails before anything was cleared must still be
    // reported, and must leave the session the user is looking at untouched.
    it("reports a failed history lookup without clearing the session", async () => {
        const { controller, clearTask, takeOver } = subject(true)
        const failure = new Error("task history is unavailable")
        controller.getTaskWithId.mockRejectedValue(failure)

        await expect(takeOver()).rejects.toBe(failure)

        expect(clearTask).not.toHaveBeenCalled()
        expect(controller.initTask).not.toHaveBeenCalled()
        expect(host.showMessage).toHaveBeenCalledExactlyOnceWith({
            type: ShowMessageType.ERROR,
            message: expect.stringContaining("task history is unavailable"),
        })
        expect(controller.postStateToWebview).toHaveBeenCalledOnce()
    })

    it("opens the session in place when nothing waits to be imported", async () => {
        const { controller, clearTask, open, takeOver } = subject(false)

        await takeOver()

        expect(controller.lockService.acquireTaskLock).toHaveBeenCalledExactlyOnceWith("task-1")
        expect(controller.taskLockAcquired).toBe(true)
        expect(open).toHaveBeenCalledOnce()
        expect(clearTask).not.toHaveBeenCalled()
        expect(controller.initTask).not.toHaveBeenCalled()
    })
})

/** An opening that failed after taking the lock but before a session owned it. */
function failedOpening(lockAcquired: boolean) {
    const controller = {
        taskLockAcquired: lockAcquired,
        trajectoryAdmission: new TrajectoryAdmission(),
        workspaceHistorySession: { taskId: "task-1" } as unknown,
        stopLockPoll: vi.fn(),
        stopLockHeartbeat: vi.fn(async () => undefined),
        releaseOwnedTaskLock: vi.fn(async () => undefined),
        stateManager: { clearTaskSettings: vi.fn(async () => undefined) },
    }
    const closeHistory = vi.fn()
    const rollback = () => prototype.rollbackUnownedOpening.call(controller, "task-1", closeHistory)
    return { controller, closeHistory, rollback }
}

describe("Controller rollback of an opening that never produced a session", () => {
    // Close finds the lock through the session; without one the heartbeat would
    // keep the lock fresh and no other window could open the task again.
    it("stops the heartbeat and releases the lock the opening took", async () => {
        const { controller, closeHistory, rollback } = failedOpening(true)

        await rollback()

        expect(controller.stopLockPoll).toHaveBeenCalledOnce()
        expect(controller.stopLockHeartbeat).toHaveBeenCalledExactlyOnceWith("task-1")
        expect(controller.releaseOwnedTaskLock).toHaveBeenCalledExactlyOnceWith("task-1")
        expect(controller.taskLockAcquired).toBe(false)
        expect(controller.stateManager.clearTaskSettings).toHaveBeenCalledExactlyOnceWith("task-1")
        expect(closeHistory).toHaveBeenCalledOnce()
        expect(controller.workspaceHistorySession).toBeUndefined()
    })

    it("leaves another window's lock alone when the opening was read-only", async () => {
        const { controller, rollback } = failedOpening(false)

        await rollback()

        expect(controller.stopLockPoll).toHaveBeenCalledOnce()
        expect(controller.releaseOwnedTaskLock).not.toHaveBeenCalled()
    })

    // The caller rethrows the opening's own error; a cleanup failure must not replace it.
    it("does not throw when the cleanup itself fails", async () => {
        const { controller, rollback } = failedOpening(true)
        controller.releaseOwnedTaskLock.mockRejectedValue(new Error("lock file is busy"))

        await expect(rollback()).resolves.toBeUndefined()
        expect(controller.taskLockAcquired).toBe(false)
    })
})
