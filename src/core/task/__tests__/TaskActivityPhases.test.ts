import { describe, expect, it } from "vitest"
import { isTaskWorkingPhase, isTaskWorkingPhaseName } from "../TaskActivityPhases"
import { TaskPhase } from "../TaskPhase"

describe("isTaskWorkingPhase", () => {
    // These phases advance on their own: the task loop reaches the next
    // provider request, tool round or turn end without any user response.
    it.each([
        TaskPhase.INITIALIZING,
        TaskPhase.STREAMING,
        TaskPhase.EXECUTING,
        TaskPhase.BETWEEN_TURNS,
        TaskPhase.RESUMING,
    ])("reports %s as working", (phase) => {
        expect(isTaskWorkingPhase(phase)).toBe(true)
    })

    /**
     * The regression this whole change exists for.
     *
     * BETWEEN_TURNS is the gap between a finished turn and the next provider
     * request. It was treated as idle by the view projector while the backend
     * cancel policy treated it as active, which cost the user the Cancel button
     * and let input bypass the queue.
     */
    it("reports the gap between turns as working, not idle", () => {
        expect(isTaskWorkingPhase(TaskPhase.BETWEEN_TURNS)).toBe(true)
    })

    // Waiting for the user is carried by an active interaction, never by the
    // phase. A phase that is parked or finished must not claim to be working.
    it.each([
        TaskPhase.IDLE,
        TaskPhase.WAITING_FOR_TASK,
        TaskPhase.AWAITING_APPROVAL,
        TaskPhase.CANCELLING,
        TaskPhase.ABORTED,
        TaskPhase.COMPLETED,
        TaskPhase.PAUSED,
    ])("does not report %s as working", (phase) => {
        expect(isTaskWorkingPhase(phase)).toBe(false)
    })
})

describe("isTaskWorkingPhaseName", () => {
    it("accepts the phase strings the Webview receives through the projection", () => {
        expect(isTaskWorkingPhaseName("between_turns")).toBe(true)
        expect(isTaskWorkingPhaseName("streaming")).toBe(true)
    })

    it("refuses an idle phase string", () => {
        expect(isTaskWorkingPhaseName("completed")).toBe(false)
    })

    // A phase this build does not know about must not inherit the ability to
    // be treated as working.
    it("refuses a phase it does not know", () => {
        expect(isTaskWorkingPhaseName("some_future_phase")).toBe(false)
    })
})
