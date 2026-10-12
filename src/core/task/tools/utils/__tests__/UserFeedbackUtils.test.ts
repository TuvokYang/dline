import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { describe, expect, it, vi } from "vitest"
import { sayFeedbackOnce } from "../UserFeedbackUtils"

const reply: SemanticInputDocument = {
    schemaVersion: 1,
    parserVersion: "1.0.0",
    catalogRevision: "3",
    documentId: "doc-reply",
    rawText: "use /explain-changes on ",
    nodes: [
        { kind: "text", text: "use " },
        {
            kind: "slash_command",
            entityId: "cmd-1",
            commandId: "command.explain_changes",
            sourceText: "/explain-changes",
            canonicalName: "explain-changes",
            namespace: "cmd",
            compositionMode: "composable",
            state: "recognized",
        },
        { kind: "text", text: " on " },
        { kind: "image", entityId: "img-1", resourceId: "res-1", displayName: "shot.png" },
    ],
    resources: [],
}

function config() {
    const say = vi.fn(async () => undefined)
    const sayUserReply = vi.fn(async () => undefined)
    return {
        say,
        sayUserReply,
        value: {
            callbacks: { say, sayUserReply },
            taskState: { ackedFeedback: undefined },
        } as never,
    }
}

describe("sayFeedbackOnce", () => {
    it("shows a structured reply as it was typed, not as what its receiver resolved", async () => {
        const host = config()

        await sayFeedbackOnce(
            host.value,
            "messageResponse",
            "use /explain-changes on <resolved>",
            ["data:image/png;base64,AA"],
            [],
            {
                draft: { text: "use /explain-changes on ", images: [], files: [], semanticInput: reply },
            },
        )

        expect(host.say).not.toHaveBeenCalled()
        expect(host.sayUserReply).toHaveBeenCalledWith({
            text: "use /explain-changes on [shot.png]",
            images: [],
            files: [],
            // A reply reaches its receiver as typed: nothing in it acted.
            submittedInputs: [
                {
                    segments: [
                        { text: "use ", role: "text", active: false },
                        { text: "/explain-changes", role: "command", active: false },
                        { text: " on ", role: "text", active: false },
                        { text: "[shot.png]", role: "resource", active: true },
                    ],
                },
            ],
        })
    })

    it("keeps the flat attachments a structured reply carried beside its document", async () => {
        const host = config()
        const textOnly: SemanticInputDocument = { ...reply, nodes: [{ kind: "text", text: "see attached" }] }

        await sayFeedbackOnce(host.value, "messageResponse", "see attached", ["data:image/png;base64,AA"], ["/a.txt"], {
            draft: { text: "see attached", images: ["data:image/png;base64,AA"], files: ["/a.txt"], semanticInput: textOnly },
        })

        expect(host.say).not.toHaveBeenCalled()
        expect(host.sayUserReply).toHaveBeenCalledWith({
            text: "see attached",
            images: ["data:image/png;base64,AA"],
            files: ["/a.txt"],
            submittedInputs: [{ segments: [{ text: "see attached", role: "text", active: false }] }],
        })
    })

    it("shows a legacy reply with its text and attachments", async () => {
        const host = config()

        await sayFeedbackOnce(host.value, "messageResponse", "looks good", ["data:image/png;base64,AA"], ["/a.txt"], {
            draft: { text: "looks good", images: [], files: [] },
        })

        expect(host.sayUserReply).not.toHaveBeenCalled()
        expect(host.say).toHaveBeenCalledWith("user_feedback", "looks good", ["data:image/png;base64,AA"], ["/a.txt"])
    })

    it("shows nothing when a presentation owner already showed the reply", async () => {
        const host = config()

        await sayFeedbackOnce(host.value, "messageResponse", "x", [], [], {
            feedbackPresented: true,
            draft: { text: "x", images: [], files: [], semanticInput: reply },
        })

        expect(host.say).not.toHaveBeenCalled()
        expect(host.sayUserReply).not.toHaveBeenCalled()
    })
})
