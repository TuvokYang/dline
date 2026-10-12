import { describe, expect, it } from "vitest"
import { type InteractionDraft, type PendingSuccessorDraftTransfer, resolveSuccessorDraft } from "../types"

// The decision never inspects the draft body; an opaque value keeps that visible.
const transfer: PendingSuccessorDraftTransfer = {
    sourceTaskId: "source",
    interactionId: "tid-1",
    draft: { opaque: true } as unknown as InteractionDraft,
}

const successorView = { taskId: "next", projectedTaskId: "next", handoffSource: { taskId: "source", interactionId: "tid-1" } }

describe("resolveSuccessorDraft", () => {
    it.each([
        ["no task is selected", {}],
        ["the source task is still shown", { taskId: "source", projectedTaskId: "source" }],
        ["the projection has not settled on the selected task", { ...successorView, projectedTaskId: "source" }],
    ])("waits while %s", (_label, surface) => {
        expect(resolveSuccessorDraft(transfer, surface)).toBe("wait")
    })

    it("restores the draft on the opening the backend says this handoff started", () => {
        expect(resolveSuccessorDraft(transfer, successorView)).toBe("restore")
    })

    it.each([
        ["a task with no handoff source", { taskId: "other", projectedTaskId: "other" }],
        [
            "a successor of a different New Task interaction",
            { ...successorView, handoffSource: { taskId: "source", interactionId: "tid-2" } },
        ],
        [
            "a successor of a different source task",
            { ...successorView, handoffSource: { taskId: "elsewhere", interactionId: "tid-1" } },
        ],
    ])("drops the draft on %s", (_label, surface) => {
        expect(resolveSuccessorDraft(transfer, surface)).toBe("drop")
    })
})
