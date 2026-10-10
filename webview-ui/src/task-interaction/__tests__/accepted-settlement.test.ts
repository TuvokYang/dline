import { describe, expect, it } from "vitest"
import { canApplyAcceptedInteractionSettlement, createAcceptedInteractionSettlement, type InteractionDraft } from "../types"

const dispatchedRequest = {
    taskId: "task-1",
    turnId: "turn-1",
    interactionId: "interaction-1",
    actionId: "approve" as const,
    stateRevision: 8,
    draft: { text: "original", images: ["image"], files: ["file"] },
}

function originalDraft(): InteractionDraft {
    return {
        text: "original",
        images: ["image"],
        files: ["file"],
        activeQuote: "quote",
        ownerRevision: 3,
    }
}

describe("accepted interaction settlement", () => {
    it("applies only to the same task and unchanged owner revision", () => {
        const draft = originalDraft()
        const settlement = createAcceptedInteractionSettlement(dispatchedRequest, draft)

        expect(canApplyAcceptedInteractionSettlement("task-1", draft, settlement)).toBe(true)
        expect(canApplyAcceptedInteractionSettlement("task-2", draft, settlement)).toBe(false)
        expect(
            canApplyAcceptedInteractionSettlement("task-1", { ...draft, ownerRevision: draft.ownerRevision! + 1 }, settlement),
        ).toBe(false)
    })

    it("rejects a late settlement after the user returns to the same visible draft", () => {
        const draft = originalDraft()
        const settlement = createAcceptedInteractionSettlement(dispatchedRequest, draft)
        const laterDraft = {
            ...draft,
            images: [...draft.images],
            files: [...draft.files],
            ownerRevision: draft.ownerRevision! + 2,
        }

        expect(canApplyAcceptedInteractionSettlement("task-1", laterDraft, settlement)).toBe(false)
    })
})
