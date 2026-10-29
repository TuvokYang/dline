import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TrajectoryAdmission } from "@/core/trajectory/TrajectorySource"
import { Controller } from "../index"

vi.mock("@/core/storage/disk", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/core/storage/disk")>()),
    cleanupStaleTaskTempFiles: vi.fn(async () => undefined),
}))

const TASK_ID = "task-1"
const HEARTBEAT_MS = 60_000

const prototype = Controller.prototype as unknown as {
    startLockHeartbeat: (taskId: string) => void
    takeOverTaskAfterUnlock: (owner: unknown, scope: unknown) => Promise<void>
}

/**
 * A lock-holding window whose heartbeat is about to run.
 *
 * Only the members the heartbeat reads are present, so an unexpected path fails
 * loudly instead of passing against a stub.
 */
function heartbeatSubject(held: boolean) {
    const opening = { taskId: TASK_ID }
    const admission = new TrajectoryAdmission()
    admission.admit(TASK_ID)
    let admittedWhenCloseQueued: boolean | undefined
    // The close waits behind other lifecycle work and never finishes here.
    const clearTask = vi.fn(() => {
        admittedWhenCloseQueued = admission.admits(TASK_ID)
        return new Promise<void>(() => undefined)
    })
    const controller: Record<string, unknown> = {
        lockHeartbeatTimer: undefined,
        lockHeartbeatLease: undefined,
        lockHeartbeatPending: undefined,
        trajectoryAdmission: admission,
        currentOpening: () => opening,
        lockService: { touchTaskLock: vi.fn(async () => held) },
        clearTask,
    }
    const start = () => prototype.startLockHeartbeat.call(controller, TASK_ID)
    const stop = () => clearInterval(controller.lockHeartbeatTimer as ReturnType<typeof setInterval>)
    return { opening, admission, clearTask, start, stop, admittedWhenCloseQueued: () => admittedWhenCloseQueued }
}

describe("Controller trajectory admission on heartbeat", () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    // A close can wait behind other lifecycle work; trajectory.db must not see a
    // new write from this window while another one already holds the lock.
    it("withdraws write access before the lock-lost close is even queued", async () => {
        const subject = heartbeatSubject(false)
        const notified: boolean[] = []
        subject.admission.onDidChange(() => notified.push(subject.admission.admits(TASK_ID)))
        subject.start()

        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
        subject.stop()

        expect(subject.clearTask).toHaveBeenCalledExactlyOnceWith({ expectedOpening: subject.opening, closeReason: "lock_lost" })
        expect(subject.admittedWhenCloseQueued()).toBe(false)
        expect(notified).toEqual([false])
    })

    it("keeps write access while the heartbeat still holds the lock", async () => {
        const subject = heartbeatSubject(true)
        subject.start()

        await vi.advanceTimersByTimeAsync(HEARTBEAT_MS)
        subject.stop()

        expect(subject.clearTask).not.toHaveBeenCalled()
        expect(subject.admission.admits(TASK_ID)).toBe(true)
    })
})

/** A window that opened the task without its lock, now trying to take it over. */
function takeoverSubject(acquired: boolean) {
    const owner = { taskId: TASK_ID }
    const admission = new TrajectoryAdmission()
    const controller = {
        disposed: false,
        taskLockAcquired: false,
        trajectoryAdmission: admission,
        historyDisplaySession: undefined,
        currentOpening: () => owner,
        task: {
            taskId: TASK_ID,
            upgradeImportPending: false,
            activateCollaboration: vi.fn(),
            task: { open: vi.fn(async () => undefined) },
            activateBackgroundIngress: vi.fn(async () => undefined),
        },
        lockService: { acquireTaskLock: vi.fn(async () => acquired) },
        stopLockPoll: vi.fn(),
        startLockHeartbeat: vi.fn(),
        postStateToWebview: vi.fn(async () => undefined),
    }
    const takeOver = () => prototype.takeOverTaskAfterUnlock.call(controller, owner, { clearTask: vi.fn() })
    return { admission, takeOver }
}

describe("Controller trajectory admission on lock takeover", () => {
    // The stream stays open across the takeover and recovers from this signal alone.
    it("admits the opening and notifies once the released lock is acquired", async () => {
        const { admission, takeOver } = takeoverSubject(true)
        const notified: boolean[] = []
        admission.onDidChange(() => notified.push(admission.admits(TASK_ID)))

        await takeOver()

        expect(admission.admits(TASK_ID)).toBe(true)
        expect(notified).toEqual([true])
    })

    it("stays without write access when another window took the lock first", async () => {
        const { admission, takeOver } = takeoverSubject(false)

        await takeOver()

        expect(admission.admits(TASK_ID)).toBe(false)
    })
})
