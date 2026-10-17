import { MutateInputQueueRequest } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import { mutateInputQueue } from "../mutateInputQueue"

/** A writable task boundary whose queue accepts every change. */
function liveTask(taskId: string) {
    return {
        taskId,
        writable: true,
        inputQueue: { mutate: vi.fn(async () => ({ accepted: true, result: "ok" })) },
    }
}

/** A controller showing `taskId` as a history display; promotion yields `promoted`. */
function historyDisplay(promoted: ReturnType<typeof liveTask> | undefined) {
    const subject = {
        task: undefined as ReturnType<typeof liveTask> | undefined,
        promoteHistoryDisplayForActivityControl: vi.fn(async () => {
            subject.task = promoted
            return promoted !== undefined
        }),
        postStateToWebview: vi.fn(async () => undefined),
    }
    return subject
}

const removal = MutateInputQueueRequest.create({ taskId: "task-1", remove: { entryId: "entry-1" } })

describe("mutateInputQueue", () => {
    it("promotes a history display so a queued entry can be removed", async () => {
        const task = liveTask("task-1")
        const controller = historyDisplay(task)

        const response = await mutateInputQueue(controller as never, removal)

        expect(controller.promoteHistoryDisplayForActivityControl).toHaveBeenCalledWith("task-1")
        expect(task.inputQueue.mutate).toHaveBeenCalledWith({ kind: "remove", entryId: "entry-1" })
        expect(response).toMatchObject({ accepted: true })
    })

    it("refuses the change when the display cannot be promoted", async () => {
        const controller = historyDisplay(undefined)

        const response = await mutateInputQueue(controller as never, removal)

        expect(response).toMatchObject({ accepted: false, result: "missing_task" })
    })

    it("acts on the active task without promoting anything", async () => {
        const task = liveTask("task-1")
        const controller = {
            task,
            promoteHistoryDisplayForActivityControl: vi.fn(async () => true),
            postStateToWebview: vi.fn(async () => undefined),
        }

        const response = await mutateInputQueue(controller as never, removal)

        expect(controller.promoteHistoryDisplayForActivityControl).not.toHaveBeenCalled()
        expect(task.inputQueue.mutate).toHaveBeenCalledOnce()
        expect(response).toMatchObject({ accepted: true })
    })

    // The Webview holds no local queue copy, so without this publication an
    // accepted entry stays invisible until an unrelated state change happens.
    it("publishes immediately after an accepted discrete change", async () => {
        const task = liveTask("task-1")
        const controller = {
            task,
            promoteHistoryDisplayForActivityControl: vi.fn(async () => true),
            postStateToWebview: vi.fn(async () => undefined),
        }

        await mutateInputQueue(controller as never, removal)

        expect(controller.postStateToWebview).toHaveBeenCalledWith({ immediate: true })
    })

    // A drag emits many reorders; each immediate publication costs a full state
    // build, so they must stay on the coalesced path.
    it("leaves a reorder on the coalesced publication path", async () => {
        const task = liveTask("task-1")
        const controller = {
            task,
            promoteHistoryDisplayForActivityControl: vi.fn(async () => true),
            postStateToWebview: vi.fn(async () => undefined),
        }

        await mutateInputQueue(
            controller as never,
            MutateInputQueueRequest.create({ taskId: "task-1", reorder: { entryId: "entry-1", targetIndex: 2 } }),
        )

        expect(controller.postStateToWebview).toHaveBeenCalledWith(undefined)
    })

    it("publishes nothing when the canonical queue refuses the change", async () => {
        const task = liveTask("task-1")
        task.inputQueue.mutate = vi.fn(async () => ({ accepted: false, result: "missing_entry" }))
        const controller = {
            task,
            promoteHistoryDisplayForActivityControl: vi.fn(async () => true),
            postStateToWebview: vi.fn(async () => undefined),
        }

        const response = await mutateInputQueue(controller as never, removal)

        expect(response).toMatchObject({ accepted: false, result: "missing_entry" })
        expect(controller.postStateToWebview).not.toHaveBeenCalled()
    })

    it("publishes nothing when the window shows the task read-only", async () => {
        const task = { ...liveTask("task-1"), writable: false }
        const controller = {
            task,
            promoteHistoryDisplayForActivityControl: vi.fn(async () => true),
            postStateToWebview: vi.fn(async () => undefined),
        }

        const response = await mutateInputQueue(controller as never, removal)

        expect(response).toMatchObject({ accepted: false, result: "task_read_only" })
        expect(controller.postStateToWebview).not.toHaveBeenCalled()
    })
})
