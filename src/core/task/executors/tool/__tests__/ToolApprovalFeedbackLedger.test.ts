import { describe, expect, it } from "vitest"
import { hasApprovalFeedback, InMemoryToolApprovalFeedbackLedger } from "../ToolApprovalFeedbackLedger"

describe("InMemoryToolApprovalFeedbackLedger", () => {
    it("returns the feedback recorded for one block exactly once", () => {
        const ledger = new InMemoryToolApprovalFeedbackLedger()

        ledger.record("block-1", { text: "read only the header" })

        expect(ledger.take("block-1")).toEqual({ text: "read only the header" })
        // Taken once so a replayed response cannot repeat the instruction in a
        // later turn, which would apply it to a tool it was never written for.
        expect(ledger.take("block-1")).toBeUndefined()
    })

    it("keeps concurrent approvals from absorbing each other's feedback", () => {
        const ledger = new InMemoryToolApprovalFeedbackLedger()

        ledger.record("edit", { text: "use the src folder" })
        ledger.record("command", { text: "use the dev script" })

        expect(ledger.take("command")).toEqual({ text: "use the dev script" })
        expect(ledger.take("edit")).toEqual({ text: "use the src folder" })
    })

    it("ignores an approval the user submitted without typing anything", () => {
        const ledger = new InMemoryToolApprovalFeedbackLedger()

        ledger.record("block-1", { text: "   ", images: [], files: [] })

        expect(ledger.take("block-1")).toBeUndefined()
    })

    it("keeps attachments submitted without text", () => {
        const ledger = new InMemoryToolApprovalFeedbackLedger()

        ledger.record("block-1", { text: "", images: ["image-1"], files: [] })

        expect(ledger.take("block-1")).toEqual({ text: "", images: ["image-1"], files: [] })
    })

    it("drops everything when the task clears the ledger", () => {
        const ledger = new InMemoryToolApprovalFeedbackLedger()

        ledger.record("block-1", { text: "note" })
        ledger.clear()

        expect(ledger.take("block-1")).toBeUndefined()
    })
})

describe("hasApprovalFeedback", () => {
    it("treats whitespace-only text as nothing the user contributed", () => {
        expect(hasApprovalFeedback({ text: "\n\t " })).toBe(false)
        expect(hasApprovalFeedback({ text: "note" })).toBe(true)
        expect(hasApprovalFeedback({ files: ["file-1"] })).toBe(true)
        expect(hasApprovalFeedback({})).toBe(false)
    })

    it("counts a note whose only content is a resource the user placed in it", () => {
        const resource = {
            kind: "resource",
            entityId: "image-1",
            nodeKind: "image",
            ref: {
                resourceId: "res-1",
                expectedContentHash: "sha256:00",
                mediaType: "image/png",
                byteLength: 1,
                owner: { kind: "task", taskId: "task-1" },
                generation: 1,
            },
            displayName: "shot.png",
        } as const
        const ledger = new InMemoryToolApprovalFeedbackLedger()

        ledger.record("block-1", { text: "", admittedParts: [resource] })

        expect(hasApprovalFeedback({ text: "", admittedParts: [{ kind: "text", text: "  " }] })).toBe(false)
        expect(ledger.take("block-1")?.admittedParts).toEqual([resource])
    })
})
