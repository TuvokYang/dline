import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { OWNERLESS_LOCK_POLL_MS, openingTrajectoryAccess } from "../OpeningTrajectoryAccess"
import { TrajectoryAdmission } from "../TrajectorySource"

const TASK = "task-1"

describe("openingTrajectoryAccess", () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it("lets a live opening write only while it is current and holds the task lock", () => {
        const admission = new TrajectoryAdmission()
        let current = true
        const access = openingTrajectoryAccess({ taskId: TASK, isCurrent: () => current, admission })
        const changed = vi.fn()
        access.onDidChange(changed)

        expect(access.writable()).toBe(false)
        admission.admit(TASK)
        expect(access.writable()).toBe(true)
        admission.admit("another-task")
        expect(access.writable()).toBe(false)
        admission.admit(TASK)

        // A lost lock is visible synchronously, before any close work runs.
        admission.revoke()
        expect(access.writable()).toBe(false)
        expect(changed).toHaveBeenCalledTimes(4)

        admission.admit(TASK)
        current = false
        expect(access.writable()).toBe(false)
    })

    it("never polls the lock for a live opening", async () => {
        const inspect = vi.fn(async () => true)
        const access = openingTrajectoryAccess({ taskId: TASK, isCurrent: () => true, admission: new TrajectoryAdmission() })
        access.onDidChange(() => undefined)

        await access.refresh()
        await vi.advanceTimersByTimeAsync(10 * OWNERLESS_LOCK_POLL_MS)

        expect(inspect).not.toHaveBeenCalled()
        expect(access.writable()).toBe(false)
    })

    it("follows a history display's lock within one poll round in both directions", async () => {
        let ownerless = true
        const access = openingTrajectoryAccess({
            taskId: TASK,
            isCurrent: () => true,
            admission: new TrajectoryAdmission(),
            inspectOwnerless: async () => ownerless,
        })
        const changed = vi.fn()
        access.onDidChange(changed)
        await access.refresh()
        expect(access.writable()).toBe(true)

        ownerless = false
        await vi.advanceTimersByTimeAsync(OWNERLESS_LOCK_POLL_MS)
        expect(access.writable()).toBe(false)
        expect(changed).toHaveBeenCalled()

        changed.mockClear()
        ownerless = true
        await vi.advanceTimersByTimeAsync(OWNERLESS_LOCK_POLL_MS)
        expect(access.writable()).toBe(true)
        expect(changed).toHaveBeenCalled()
    })

    it("notifies on every round while writable, so commits of another window wake catch-up", async () => {
        const access = openingTrajectoryAccess({
            taskId: TASK,
            isCurrent: () => true,
            admission: new TrajectoryAdmission(),
            inspectOwnerless: async () => true,
        })
        const changed = vi.fn()
        access.onDidChange(changed)

        await vi.advanceTimersByTimeAsync(3 * OWNERLESS_LOCK_POLL_MS)

        expect(changed).toHaveBeenCalledTimes(3)
    })

    it("stops polling once nothing listens", async () => {
        const inspect = vi.fn(async () => true)
        const access = openingTrajectoryAccess({
            taskId: TASK,
            isCurrent: () => true,
            admission: new TrajectoryAdmission(),
            inspectOwnerless: inspect,
        })
        const stop = access.onDidChange(() => undefined)
        await vi.advanceTimersByTimeAsync(OWNERLESS_LOCK_POLL_MS)
        expect(inspect).toHaveBeenCalledTimes(1)

        stop()
        await vi.advanceTimersByTimeAsync(10 * OWNERLESS_LOCK_POLL_MS)

        expect(inspect).toHaveBeenCalledTimes(1)
    })

    it("grants nothing when the lock cannot be read", async () => {
        const access = openingTrajectoryAccess({
            taskId: TASK,
            isCurrent: () => true,
            admission: new TrajectoryAdmission(),
            inspectOwnerless: async () => {
                throw new Error("lock file unreadable")
            },
        })

        await access.refresh()

        expect(access.writable()).toBe(false)
    })
})
