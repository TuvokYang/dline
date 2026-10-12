import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { hasTransitionDraftContent } from "@shared/TransitionDraft"
import { describe, expect, it } from "vitest"
import { transitionChatContentOf } from "./transitionDraft"

function documentOf(nodes: SemanticInputDocument["nodes"], rawText = ""): SemanticInputDocument {
    return {
        schemaVersion: 1,
        parserVersion: "1.0.0",
        catalogRevision: "3",
        documentId: "doc-transition",
        rawText,
        nodes,
        resources: [],
    }
}

// Only the node kind matters to the predicate; the resource binding is irrelevant here.
const IMAGE_NODE = {
    kind: "image",
    entityId: "image-1",
    displayName: "shot.png",
} as unknown as SemanticInputDocument["nodes"][number]

describe("transition drafts", () => {
    it("counts a draft holding only a resource as content", () => {
        const draft = { text: "", images: [], files: [], semanticInput: documentOf([IMAGE_NODE]) }

        expect(hasTransitionDraftContent(draft)).toBe(true)
        expect(transitionChatContentOf(draft)).toMatchObject({ message: undefined, semanticInput: expect.anything() })
    })

    it("treats whitespace-only text and empty text nodes as no draft", () => {
        const draft = { text: "  ", images: [], files: [], semanticInput: documentOf([{ kind: "text", text: "  " }], "  ") }

        expect(hasTransitionDraftContent(draft)).toBe(false)
        expect(hasTransitionDraftContent(undefined)).toBe(false)
        expect(transitionChatContentOf(draft)).toBeUndefined()
    })

    it("carries the composed document with the text it was composed from", () => {
        const semanticInput = documentOf([{ kind: "text", text: "draft" }], "draft")
        const content = transitionChatContentOf({ text: "draft", images: [], files: [], semanticInput })

        expect(content?.message).toBe("draft")
        expect(content?.semanticInput).toBeDefined()
    })
})
