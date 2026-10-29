import { describe, expect, it } from "vitest"
import { createInitialTaskState, type TaskEvent, type TaskState, type TransitionResult, transition } from ".."

const COMPLETION_RULES = [
    { actionId: "reply", payloadPolicy: "draft" as const },
    { actionId: "start_new_task", payloadPolicy: "draft" as const },
]

function accepted(result: TransitionResult): TaskState {
    expect(result.kind).toBe("accepted")
    return result.state
}

function executingTurn(turnEnding = true): TaskState {
    return {
        ...createInitialTaskState("task-1"),
        flow: { phase: "running" },
        turn: {
            turnId: "turn-1",
            mode: "serial",
            blocks: [
                {
                    blockId: "block-1",
                    index: 0,
                    phase: "executing",
                    attempt: "attempt-1",
                    invocationRef: "invocation:block-1",
                    lanes: ["user-interaction"],
                    turnEnding,
                },
            ],
            manualApprovalBlockIds: [],
            automaticApprovalBlockIds: ["block-1"],
            executingBlockIds: ["block-1"],
        },
    }
}

const presented = (state: TaskState): TaskEvent => ({
    type: "tool.completion_presented",
    generation: state.generation,
    attempt: "attempt-1",
    turnId: "turn-1",
    blockId: "block-1",
    presentationRef: "presentation:completion",
    actionRules: COMPLETION_RULES,
})

function halt(state: TaskState, type: "user.cancel" | "user.terminate"): TaskState {
    let next = accepted(transition(state, { type, generation: state.generation, haltId: "halt-1" }))
    if (next.halt.status !== "stopping") throw new Error("expected stopping")
    for (const participantId of [...next.halt.pending]) {
        next = accepted(transition(next, { type: "halt.halted", generation: next.generation, haltId: "halt-1", participantId }))
    }
    return next
}

describe("terminating a turn whose completion is already shown", () => {
    it("records the shown completion on its block without emitting work", () => {
        const state = executingTurn()
        const result = transition(state, presented(state))

        expect(result).toMatchObject({ kind: "accepted", commands: [] })
        expect(result.state.turn.blocks[0]).toMatchObject({
            phase: "executing",
            presentedCompletion: { presentationRef: "presentation:completion", actionRules: COMPLETION_RULES },
        })
        expect(result.state.flow).toMatchObject({ phase: "completed", completionId: "block-1" })
    })

    it("reopens a completed task only when the user replies to its completion", () => {
        const staged = accepted(transition(executingTurn(), presented(executingTurn())))
        const awaiting: TaskState = {
            ...staged,
            dialog: {
                primary: {
                    interactionId: "block-1",
                    turnId: "turn-1",
                    kind: "completion",
                    status: "awaiting",
                    createdRevision: staged.revision,
                    presentationRef: "presentation:completion",
                    actionRules: COMPLETION_RULES,
                    receiverGeneration: staged.generation,
                },
                approvalsByBlock: {},
            },
        }

        const replied = accepted(
            transition(awaiting, {
                type: "dialog.responded",
                generation: awaiting.generation,
                taskId: awaiting.taskId,
                turnId: "turn-1",
                interactionId: "block-1",
                stateRevision: awaiting.revision,
                receiverGeneration: awaiting.generation,
                actionId: "reply",
                draftRef: "draft-1",
            }),
        )

        expect(replied.flow.phase).toBe("running")
        expect(replied.flow.completionId).toBeUndefined()
    })

    it("refuses a duplicate, a block that does not end the turn, and a stopping task", () => {
        const staged = accepted(transition(executingTurn(), presented(executingTurn())))
        expect(transition(staged, presented(staged))).toMatchObject({ kind: "rejected", reason: "duplicate" })

        const ordinary = executingTurn(false)
        expect(transition(ordinary, presented(ordinary))).toMatchObject({ kind: "rejected", reason: "phase_invalid" })

        const stopping = accepted(transition(executingTurn(), { type: "user.terminate", generation: 0, haltId: "halt-1" }))
        expect(transition(stopping, presented(stopping)).kind).toBe("rejected")
    })

    it("ends terminated with the block settled and the shown completion as the dialog", () => {
        const staged = accepted(transition(executingTurn(), presented(executingTurn())))
        const terminated = halt(staged, "user.terminate")

        expect(terminated.flow.phase).toBe("terminated")
        expect(terminated.turn.blocks[0]?.phase).toBe("cancelled")
        expect(terminated.turn.executingBlockIds).toEqual([])
        expect(terminated.dialog.primary).toMatchObject({
            interactionId: "block-1",
            turnId: "turn-1",
            kind: "completion",
            status: "planned",
            presentationRef: "presentation:completion",
            actionRules: COMPLETION_RULES,
        })
    })

    it("settles an interrupted tool without inventing a completion", () => {
        const terminated = halt(executingTurn(), "user.terminate")

        expect(terminated.flow.phase).toBe("terminated")
        expect(terminated.turn.blocks[0]?.phase).toBe("cancelled")
        expect(terminated.turn.executingBlockIds).toEqual([])
        expect(terminated.dialog.primary).toBeUndefined()
    })

    it("leaves a cancel paused and resumable rather than finished", () => {
        const staged = accepted(transition(executingTurn(), presented(executingTurn())))
        const paused = halt(staged, "user.cancel")

        expect(paused.flow.phase).toBe("paused")
        expect(paused.dialog.primary).toBeUndefined()
    })
})
