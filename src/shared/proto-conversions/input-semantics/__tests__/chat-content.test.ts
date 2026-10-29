import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { ChatContent as WireChatContent } from "@shared/proto/dline/state"
import { describe, expect, it } from "vitest"
import { fromProtoChatContent, toProtoChatContent } from "../chat-content"
import { toProtoSemanticInputDocument } from "../document"

const semanticInput: SemanticInputDocument = {
    schemaVersion: 1,
    parserVersion: "1.0.0",
    catalogRevision: "4",
    documentId: "doc-draft",
    rawText: "keep [file:r1] and /compact",
    nodes: [
        { kind: "text", text: "keep " },
        { kind: "file", entityId: "e1", resourceId: "r1", fileOrigin: "pasted_text", displayName: "input.txt", lineCount: 30 },
        { kind: "text", text: " and " },
        { kind: "literal", text: "/compact", source: "pasted" },
    ],
    resources: [
        {
            resourceId: "r1",
            expectedContentHash: "hash-1",
            mediaType: "text/plain",
            byteLength: 6200,
            owner: { kind: "task", taskId: "task-1" },
            generation: 1,
        },
    ],
}

describe("ChatContent proto conversion", () => {
    it("carries the semantic draft of a transition next to its legacy mirror", () => {
        const decoded = fromProtoChatContent(toProtoChatContent({ message: semanticInput.rawText, semanticInput }))

        expect(decoded).toEqual({ ok: true, content: { message: semanticInput.rawText, semanticInput } })
    })

    it("keeps a legacy client's flat draft as it is", () => {
        const decoded = fromProtoChatContent(WireChatContent.create({ message: "hello", images: ["data:x"], files: ["/a.pdf"] }))

        expect(decoded).toEqual({ ok: true, content: { message: "hello", images: ["data:x"], files: ["/a.pdf"] } })
    })

    it("reports no content when the request carried none", () => {
        expect(fromProtoChatContent(undefined)).toEqual({ ok: true, content: undefined })
    })

    it("fails closed on a semantic draft it cannot decode instead of falling back to the flat mirror", () => {
        const wire = WireChatContent.create({
            message: "fallback text",
            semanticInput: { ...toProtoSemanticInputDocument(semanticInput), schemaVersion: 99 },
        })

        const decoded = fromProtoChatContent(wire)

        expect(decoded.ok).toBe(false)
        if (decoded.ok) return
        expect(decoded.diagnostic).toMatchObject({ code: "semantic_input_schema_unsupported", documentId: "doc-draft" })
    })

    it("rejects a draft that decodes but breaks the document contract", () => {
        const forged: SemanticInputDocument = {
            ...semanticInput,
            resources: [{ ...semanticInput.resources[0], generation: 0 }],
        }

        const decoded = fromProtoChatContent(toProtoChatContent({ message: forged.rawText, semanticInput: forged }))

        expect(decoded.ok).toBe(false)
        if (decoded.ok) return
        expect(decoded.diagnostic).toMatchObject({ code: "semantic_input_resource_invalid", resourceId: "r1" })
    })
})
