import { describe, expect, it } from "vitest"
import { TaskPhase } from "@/core/task/TaskPhase"
import { taskPhaseStillDelivers } from "../InputQueueDelivery"

describe("taskPhaseStillDelivers", () => {
    // These phases still reach a turn end or a tool round, so input handed to
    // the queue there will be delivered.
    it.each([
        TaskPhase.INITIALIZING,
        TaskPhase.STREAMING,
        TaskPhase.AWAITING_APPROVAL,
        TaskPhase.EXECUTING,
        TaskPhase.BETWEEN_TURNS,
        TaskPhase.RESUMING,
    ])("accepts retained input while the task is %s", (phase) => {
        expect(taskPhaseStillDelivers(phase)).toBe(true)
    })

    // A task in these phases will never run another turn, so anything the queue
    // accepted would stay there with no way for the user to send it.
    it.each([
        TaskPhase.IDLE,
        TaskPhase.WAITING_FOR_TASK,
        TaskPhase.CANCELLING,
        TaskPhase.ABORTED,
        TaskPhase.COMPLETED,
        TaskPhase.PAUSED,
    ])("refuses retained input once the task is %s", (phase) => {
        expect(taskPhaseStillDelivers(phase)).toBe(false)
    })

    // A phase this module has never heard of must not silently inherit the
    // right to hold the user's input.
    it("refuses a phase it does not know", () => {
        expect(taskPhaseStillDelivers("some_future_phase")).toBe(false)
    })
})
