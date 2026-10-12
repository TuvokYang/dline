import { describe, expect, it } from "vitest"
import { declinedNewTaskResponse, newTaskCallOf, successorDirective } from "../new-task-answer"
import { NEW_TASK_FEEDBACK_CONTINUATION_MARKER } from "../new-task-continuation"

const recorded = (input: Record<string, unknown>) => ({ input, functionId: "call-1", dlineTid: "tid-1" })

describe("new_task answers", () => {
    it("reads the call back from a recorded invocation that has both halves", () => {
        const call = newTaskCallOf(recorded({ task: "Finish", context: "Carry on" }))

        expect(call).toEqual({ task: "Finish", context: "Carry on", functionId: "call-1", dlineTid: "tid-1" })
        if (!call) return
        expect(successorDirective(call)).toEqual({
            type: "start_successor_task",
            task: "Finish",
            context: "Carry on",
            functionId: "call-1",
            dlineTid: "tid-1",
        })
    })

    it("refuses a recorded invocation the live handler would have refused", () => {
        expect(newTaskCallOf(recorded({ task: "Finish" }))).toBeUndefined()
        expect(newTaskCallOf(recorded({ context: "Carry on" }))).toBeUndefined()
        expect(newTaskCallOf(recorded({ task: "", context: "Carry on" }))).toBeUndefined()
        expect(newTaskCallOf(recorded({ task: 1, context: "Carry on" }))).toBeUndefined()
    })

    it("keeps declined feedback in the source behind the continuation marker", () => {
        const response = declinedNewTaskResponse("Stay here")

        expect(response).toBe(
            `${NEW_TASK_FEEDBACK_CONTINUATION_MARKER}\nThe user provided feedback instead of creating a new task:\n<feedback>\nStay here\n</feedback>`,
        )
    })
})
