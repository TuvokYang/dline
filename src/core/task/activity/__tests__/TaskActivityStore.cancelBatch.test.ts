import { describe, expect, it } from "vitest"
import { TaskActivityStore } from "../TaskActivityStore"

interface ControllableActivity {
    activityId: string
    releaseCancel: () => void
}

/** Register one running activity whose canceller settles on demand. */
function createControllableActivity(store: TaskActivityStore, activityId: string): ControllableActivity {
    let releaseCancel: () => void = () => undefined
    const cancelled = new Promise<void>((resolve) => {
        releaseCancel = resolve
    })
    store.create({
        activityId,
        kind: "subagent",
        executionMode: "foreground",
        title: activityId,
        status: "running",
        cancel: () => cancelled,
    })
    return { activityId, releaseCancel }
}

describe("TaskActivityStore.cancel batch determinism", () => {
    // Cancellers run concurrently so one unresponsive activity cannot consume the
    // whole caller timeout budget. Collecting results by append order made the
    // returned ids follow canceller settle order, which is decided by the remote
    // runtime rather than by the caller, so identical batches produced different
    // responses run to run.
    it("returns cancelled ids in requested order regardless of settle order", async () => {
        const store = new TaskActivityStore("task-1")
        const requested = ["activity-a", "activity-b", "activity-c"]
        const activities = requested.map((activityId) => createControllableActivity(store, activityId))

        const pending = store.cancel(requested)
        // Settle in reverse: the activity requested first is the slowest to stop.
        activities[2].releaseCancel()
        await Promise.resolve()
        activities[1].releaseCancel()
        await Promise.resolve()
        activities[0].releaseCancel()

        await expect(pending).resolves.toEqual(requested)
        store.dispose()
    })

    it("omits an activity whose canceller rejects while preserving order", async () => {
        const store = new TaskActivityStore("task-1")
        for (const activityId of ["activity-a", "activity-b", "activity-c"]) {
            store.create({
                activityId,
                kind: "subagent",
                executionMode: "foreground",
                title: activityId,
                status: "running",
                cancel: async () => {
                    if (activityId === "activity-b") throw new Error("canceller failed")
                },
            })
        }

        await expect(store.cancel(["activity-a", "activity-b", "activity-c"])).resolves.toEqual(["activity-a", "activity-c"])
        store.dispose()
    })

    it("ignores unknown ids without disturbing the order of real cancellations", async () => {
        const store = new TaskActivityStore("task-1")
        store.create({
            activityId: "running-1",
            kind: "subagent",
            executionMode: "foreground",
            title: "running-1",
            status: "running",
            cancel: async () => undefined,
        })

        await expect(store.cancel(["missing-1", "running-1", "missing-2"])).resolves.toEqual(["running-1"])
        store.dispose()
    })
})
