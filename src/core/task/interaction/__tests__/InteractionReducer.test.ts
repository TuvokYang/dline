import { describe, expect, it } from "vitest"
import { type ActiveInteraction, reduceInteraction } from "../InteractionReducer"

/** Create one awaiting interaction with causal identity. */
function awaiting(kind: ActiveInteraction["kind"] = "tool_approval"): ActiveInteraction {
    return {
        taskId: "task-1",
        turnId: "turn-1",
        interactionId: "interaction-1",
        kind,
        status: "awaiting",
        createdRevision: 4,
    }
}

describe("reduceInteraction", () => {
    it("accepts a valid action and moves to resolving", () => {
        const result = reduceInteraction(awaiting(), {
            taskId: "task-1",
            turnId: "turn-1",
            interactionId: "interaction-1",
            actionId: "approve",
            stateRevision: 4,
            draft: { text: "use smaller edits", images: [], files: [] },
        })

        expect(result).toMatchObject({ accepted: true, next: { status: "resolving" } })
    })

    it.each([
        ["followup", "reply"],
        ["make_plan", "reply"],
        ["qna_response", "reply"],
        ["generate_report", "reply"],
        ["completion", "reply"],
        ["resume", "resume"],
        ["tool_approval", "reject"],
        ["condense", "reject"],
    ] as const)("accepts the %s Enter action with a draft", (kind, actionId) => {
        const result = reduceInteraction(awaiting(kind), {
            taskId: "task-1",
            turnId: "turn-1",
            interactionId: "interaction-1",
            actionId,
            stateRevision: 4,
            draft: { text: "Continue", images: [], files: [] },
        })

        expect(result).toMatchObject({ accepted: true, next: { status: "resolving" } })
    })

    it("rejects an Enter action without its draft payload", () => {
        const state = awaiting("qna_response")
        const result = reduceInteraction(state, {
            taskId: "task-1",
            turnId: "turn-1",
            interactionId: "interaction-1",
            actionId: "reply",
            stateRevision: 4,
        })

        expect(result).toEqual({ accepted: false, next: state, error: { code: "invalid_interaction_payload" } })
    })

    it("accepts manual condense confirmation without a draft payload", () => {
        const result = reduceInteraction(awaiting("condense"), {
            taskId: "task-1",
            turnId: "turn-1",
            interactionId: "interaction-1",
            actionId: "confirm_utility",
            stateRevision: 4,
        })

        expect(result).toMatchObject({ accepted: true, next: { status: "resolving" } })
    })

    it("rejects stale identity without mutation", () => {
        const state = awaiting()
        const result = reduceInteraction(state, {
            taskId: "task-1",
            turnId: "turn-old",
            interactionId: "interaction-1",
            actionId: "approve",
            stateRevision: 4,
            draft: { text: "", images: [], files: [] },
        })

        expect(result).toEqual({ accepted: false, next: state, error: { code: "stale_interaction" } })
    })

    it("rejects focus-chain approval without selection", () => {
        const state = awaiting("change_todo_list")
        const result = reduceInteraction(state, {
            taskId: "task-1",
            turnId: "turn-1",
            interactionId: "interaction-1",
            actionId: "approve",
            stateRevision: 4,
            draft: { text: "", images: [], files: [] },
        })

        expect(result).toEqual({ accepted: false, next: state, error: { code: "invalid_interaction_payload" } })
    })
})
