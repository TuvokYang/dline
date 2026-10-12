import { describe, expect, it, vi } from "vitest"
import type { TaskEvent, TaskState } from "../../kernel"
import { createInitialTaskState } from "../../kernel"
import type { NewTaskHandoff } from "../new-task-handoff"
import {
    createSuccessorHandoffPublisher,
    newTaskConsumedRef,
    type SuccessorHandoffRuntime,
    type TaskSuccessorPort,
} from "../successor-handoff"

const directive = {
    type: "start_successor_task",
    task: "Finish the migration",
    context: "Carry the migration forward",
    functionId: "function-1",
    dlineTid: "tid-1",
} as const

const command = { turnId: "turn-1", dlineTid: "tid-1" }

function fakeRuntime(outcome: "accepted" | "rejected") {
    const order: string[] = []
    const events: TaskEvent[] = []
    const state: TaskState = { ...createInitialTaskState("task-1"), generation: 3, revision: 9 }
    const runtime: SuccessorHandoffRuntime = {
        getState: () => state,
        submit: vi.fn(async (event: TaskEvent) => {
            events.push(event)
            order.push("submit")
            return { kind: outcome, state: { ...state, revision: 10 } }
        }),
        waitForDurable: vi.fn(async (revision: number) => {
            order.push(`durable:${revision}`)
        }),
    }
    return { runtime, events, order }
}

function fakeSuccessor(order: string[]) {
    const started: NewTaskHandoff[] = []
    const successor: TaskSuccessorPort = {
        settings: () => ({ mode: "plan", planModeProfile: "planner", actModeProfile: "actor" }),
        start: vi.fn(async (handoff: NewTaskHandoff) => {
            order.push("start")
            started.push(handoff)
        }),
        onError: vi.fn(),
    }
    return { successor, started }
}

describe("successor handoff publisher", () => {
    it("starts the successor only after the source is durably consumed", async () => {
        const { runtime, events, order } = fakeRuntime("accepted")
        const { successor, started } = fakeSuccessor(order)
        const scheduled: Array<() => void> = []
        const publish = createSuccessorHandoffPublisher({
            runtime: () => runtime,
            successor,
            schedule: (run) => scheduled.push(run),
        })

        await expect(publish({ command, directive })).resolves.toBe("handed_off")

        expect(events).toEqual([
            {
                type: "lifecycle.consumed",
                generation: 3,
                turnId: "turn-1",
                blockId: "tid-1",
                consumedRef: newTaskConsumedRef(directive),
            },
        ])
        // The start is deferred past the block: starting tears the source down,
        // and that teardown waits for the block that asked for it.
        expect(started).toEqual([])
        for (const run of scheduled) run()
        await vi.waitFor(() => expect(started).toHaveLength(1))
        expect(order).toEqual(["submit", "durable:10", "start"])
        expect(started[0]).toEqual({
            task: "Finish the migration",
            context: "Carry the migration forward",
            source: { functionId: "function-1", dlineTid: "tid-1" },
            taskSettings: { mode: "plan", planModeProfile: "planner", actModeProfile: "actor" },
        })
        // The successor gets the task, context and settings alone; nothing of the
        // source conversation, such as declined-handoff feedback, travels with it.
        expect(Object.keys(started[0]).sort()).toEqual(["context", "source", "task", "taskSettings"])
    })

    it("starts nothing when the kernel refuses the handoff because the task is already stopping", async () => {
        const { runtime, order } = fakeRuntime("rejected")
        const { successor, started } = fakeSuccessor(order)
        const scheduled: Array<() => void> = []
        const publish = createSuccessorHandoffPublisher({
            runtime: () => runtime,
            successor,
            schedule: (run) => scheduled.push(run),
        })

        await expect(publish({ command, directive })).resolves.toBe("refused")

        expect(scheduled).toEqual([])
        expect(started).toEqual([])
        expect(runtime.waitForDurable).not.toHaveBeenCalled()
    })

    it("records what the source owes after it is consumed and before the successor is scheduled", async () => {
        const { runtime, order } = fakeRuntime("accepted")
        const { successor } = fakeSuccessor(order)
        const publish = createSuccessorHandoffPublisher({
            runtime: () => runtime,
            successor,
            schedule: (run) => {
                order.push("schedule")
                run()
            },
        })
        const beforeStart = vi.fn(async () => {
            order.push("beforeStart")
        })

        await expect(publish({ command, directive, beforeStart })).resolves.toBe("handed_off")

        await vi.waitFor(() => expect(order).toContain("start"))
        expect(order).toEqual(["submit", "durable:10", "beforeStart", "schedule", "start"])
    })

    it("records nothing when the kernel refuses the handoff", async () => {
        const { runtime, order } = fakeRuntime("rejected")
        const { successor } = fakeSuccessor(order)
        const publish = createSuccessorHandoffPublisher({ runtime: () => runtime, successor, schedule: (run) => run() })
        const beforeStart = vi.fn(async () => undefined)

        await expect(publish({ command, directive, beforeStart })).resolves.toBe("refused")

        expect(beforeStart).not.toHaveBeenCalled()
    })

    it("marks the consumption of a dialog restored after its block's process ended", async () => {
        const { runtime, events, order } = fakeRuntime("accepted")
        const { successor, started } = fakeSuccessor(order)
        const publish = createSuccessorHandoffPublisher({ runtime: () => runtime, successor, schedule: (run) => run() })

        await expect(publish({ command: { ...command, restoredDialog: true }, directive })).resolves.toBe("handed_off")

        expect(events).toEqual([
            {
                type: "lifecycle.consumed",
                generation: 3,
                turnId: "turn-1",
                blockId: "tid-1",
                consumedRef: newTaskConsumedRef(directive),
                restoredDialog: true,
            },
        ])
        await vi.waitFor(() => expect(started).toHaveLength(1))
    })

    it("leaves directives other than a successor start untouched", async () => {
        const { runtime, order } = fakeRuntime("accepted")
        const { successor } = fakeSuccessor(order)
        const publish = createSuccessorHandoffPublisher({ runtime: () => runtime, successor })

        await expect(publish({ command, directive: { type: "not_a_successor" } as unknown as typeof directive })).resolves.toBe(
            "not_a_handoff",
        )

        expect(runtime.submit).not.toHaveBeenCalled()
        expect(successor.start).not.toHaveBeenCalled()
    })

    it("reports a successor that failed to start instead of failing the finished block", async () => {
        const { runtime, order } = fakeRuntime("accepted")
        const { successor } = fakeSuccessor(order)
        const failure = new Error("surface closed")
        vi.mocked(successor.start).mockRejectedValueOnce(failure)
        const publish = createSuccessorHandoffPublisher({ runtime: () => runtime, successor, schedule: (run) => run() })

        await expect(publish({ command, directive })).resolves.toBe("handed_off")

        await vi.waitFor(() => expect(successor.onError).toHaveBeenCalledWith(failure))
    })

    it("fails the block when there is no active turn to hand off from", async () => {
        const { successor } = fakeSuccessor([])
        const publish = createSuccessorHandoffPublisher({ runtime: () => undefined, successor })

        await expect(publish({ command, directive })).rejects.toThrow("NewTaskHandoffWithoutActiveTurn")
        expect(successor.start).not.toHaveBeenCalled()
    })
})
