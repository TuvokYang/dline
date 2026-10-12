import { describe, expect, it } from "vitest"
import { type InteractionDraft, type PendingSuccessorDraftTransfer, resolveSuccessorDraft } from "../types"

// The decision never inspects the draft body; an opaque value keeps that visible.
const transfer: PendingSuccessorDraftTransfer = {
    sourceTaskId: "source",
    task: "Successor task",
    draft: { opaque: true } as unknown as InteractionDraft,
}

describe("resolveSuccessorDraft", () => {
    it.each([
        ["no task is selected", {}],
        ["the source task is still shown", { taskId: "source", projectedTaskId: "source", titleText: "Source task" }],
        [
            "the projection has not settled on the selected task",
            { taskId: "next", projectedTaskId: "source", titleText: "Successor task" },
        ],
        ["the selected task has no first row yet", { taskId: "next", projectedTaskId: "next" }],
    ])("waits while %s", (_label, surface) => {
        expect(resolveSuccessorDraft(transfer, surface)).toBe("wait")
    })

    it("restores the draft once the successor surface carries the transferred task", () => {
        expect(resolveSuccessorDraft(transfer, { taskId: "next", projectedTaskId: "next", titleText: "Successor task" })).toBe(
            "restore",
        )
    })

    it("drops the draft when a settled surface shows a different task", () => {
        expect(resolveSuccessorDraft(transfer, { taskId: "other", projectedTaskId: "other", titleText: "History task" })).toBe(
            "drop",
        )
    })
})
