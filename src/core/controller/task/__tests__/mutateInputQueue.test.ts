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
        const controller = { task, promoteHistoryDisplayForActivityControl: vi.fn(async () => true) }

        const response = await mutateInputQueue(controller as never, removal)

        expect(controller.promoteHistoryDisplayForActivityControl).not.toHaveBeenCalled()
        expect(task.inputQueue.mutate).toHaveBeenCalledOnce()
        expect(response).toMatchObject({ accepted: true })
    })
})
