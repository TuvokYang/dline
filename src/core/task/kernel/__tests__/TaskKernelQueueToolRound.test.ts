import { describe, expect, it } from "vitest"
import { transition } from "../transition"
import { type ComposeRoundCommand, createInitialTaskState, type TaskEvent, type TaskState } from "../types"

function apply(state: TaskState, event: TaskEvent) {
    const result = transition(state, event)
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result
}

function toolRound(): TaskState {
    const initial = createInitialTaskState("task-1")
    return {
        ...initial,
        flow: { phase: "running" },
        turn: {
            ...initial.turn,
            turnId: "turn-1",
            blocks: [
                {
                    blockId: "read",
                    attempt: "attempt-1",
                    index: 0,
                    phase: "executing",
                    lanes: [],
                    turnEnding: false,
                    invocationRef: "read:1",
                },
            ],
            executingBlockIds: ["read"],
        },
    }
}

function retained(state: TaskState, entryId: string, mode: "queued" | "steering", editing = false): TaskState {
    let next = apply(state, { type: "input_queue.enqueued", generation: 0, entryId, payloadRef: `payload:${entryId}` }).state
    if (mode === "steering") next = apply(next, { type: "input_queue.mode_toggled", generation: 0, entryId }).state
    if (editing) next = apply(next, { type: "input_queue.edit_started", generation: 0, entryId }).state
    return next
}

function finish(state: TaskState) {
    return apply(state, { type: "tool.completed", generation: 0, turnId: "turn-1", blockId: "read", attempt: "attempt-1" })
}

describe("retained input admission at tool-round boundaries", () => {
    it("reserves all non-editing steering entries in order, leaving queued and editing input retained", () => {
        let state = retained(toolRound(), "queued", "queued")
        state = retained(state, "steer-a", "steering")
        state = retained(state, "editing", "steering", true)
        state = retained(state, "steer-b", "steering")
        const result = finish(state)
        const compose = result.commands.find((command): command is ComposeRoundCommand => command.type === "compose.round")
        expect(compose?.admittedEntryIds).toEqual(["steer-a", "steer-b"])
        expect(compose?.queueDelivery).toMatchObject({ point: "tool_round", ownerId: compose?.commandId })
        expect(result.state.intake.queued.filter((entry) => entry.state === "reserved").map((entry) => entry.entryId)).toEqual([
            "steer-a",
            "steer-b",
        ])
        expect(result.state.intake.queued.find((entry) => entry.entryId === "queued")?.state).toBe("accepted")
        expect(result.state.intake.queued.find((entry) => entry.entryId === "editing")?.queue?.editing).toBe(true)
    })

    it("releases a selected batch on compose failure without replacing the chosen order", () => {
        const result = finish(retained(retained(toolRound(), "first", "steering"), "second", "steering"))
        const compose = result.commands.find((command): command is ComposeRoundCommand => command.type === "compose.round")
        if (!compose) throw new Error("Missing compose command")
        const failed = apply(result.state, {
            type: "compose.failed",
            generation: 0,
            commandId: compose.commandId,
            originRevision: compose.originRevision,
            message: "draft failed",
        })
        expect(failed.state.intake.queued.map((entry) => entry.state)).toEqual(["released", "released"])
        expect(failed.state.intake.queued.map((entry) => entry.queue?.delivery)).toEqual([undefined, undefined])
        expect(failed.state.intake.queued.map((entry) => entry.entryId)).toEqual(["first", "second"])
    })
})
