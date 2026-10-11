import { describe, expect, it } from "vitest"
import type { SemanticInputDocument, SemanticResourceRef } from "../document"
import { documentBeforeEntity } from "../document-slice"
import { presentationTextOf } from "../presentation"
import { validateSemanticInputDocument } from "../validation"

function resource(resourceId: string, mediaType: string): SemanticResourceRef {
    return {
        resourceId,
        expectedContentHash: `hash-${resourceId}`,
        mediaType,
        byteLength: 10,
        owner: { kind: "task", taskId: "task-1" },
        generation: 1,
    }
}

const compact: SemanticInputDocument["nodes"][number] = {
    kind: "slash_command",
    entityId: "barrier",
    commandId: "command.compact",
    sourceText: "/compact",
    canonicalName: "compact",
    namespace: "cmd",
    compositionMode: "lifecycle_barrier",
    state: "recognized",
}

function document(nodes: SemanticInputDocument["nodes"]): SemanticInputDocument {
    const draft: SemanticInputDocument = {
        schemaVersion: 1,
        parserVersion: "1.0.0",
        catalogRevision: "3",
        documentId: "doc-1",
        rawText: "",
        nodes,
        resources: [resource("r1", "image/png"), resource("r2", "text/plain")],
    }
    return { ...draft, rawText: presentationTextOf(draft) }
}

describe("documentBeforeEntity", () => {
    it("keeps the nodes in front of the entity and only the resources they reference", () => {
        const source = document([
            { kind: "text", text: "  compare " },
            { kind: "image", entityId: "e1", resourceId: "r1", displayName: "before.png" },
            { kind: "text", text: " then " },
            compact,
            { kind: "text", text: " keep " },
            { kind: "file", entityId: "e2", resourceId: "r2", fileOrigin: "pasted_text", displayName: "notes.txt" },
        ])

        const prefix = documentBeforeEntity(source, "barrier")

        expect(prefix?.nodes).toEqual([
            { kind: "text", text: "compare " },
            { kind: "image", entityId: "e1", resourceId: "r1", displayName: "before.png" },
            { kind: "text", text: " then" },
        ])
        // The file after the barrier no longer belongs to the kept submission.
        expect(prefix?.resources.map((ref) => ref.resourceId)).toEqual(["r1"])
        expect(prefix?.rawText).toBe("compare [image:r1] then")
        expect(prefix?.documentId).toBe(source.documentId)
        // The slice is still a document the admission boundary accepts as-is.
        expect(prefix && validateSemanticInputDocument(prefix)).toEqual([])
    })

    it("yields an empty document when the entity opens the input", () => {
        const prefix = documentBeforeEntity(document([compact, { kind: "text", text: " keep the audit" }]), "barrier")

        expect(prefix?.nodes).toEqual([])
        expect(prefix?.resources).toEqual([])
        expect(prefix?.rawText).toBe("")
    })

    it("drops whitespace-only edge text instead of keeping an empty node", () => {
        const prefix = documentBeforeEntity(
            document([
                { kind: "image", entityId: "e1", resourceId: "r1", displayName: "a.png" },
                { kind: "text", text: "  " },
                compact,
            ]),
            "barrier",
        )

        expect(prefix?.nodes).toEqual([{ kind: "image", entityId: "e1", resourceId: "r1", displayName: "a.png" }])
    })

    it("reports a missing entity rather than returning the whole document", () => {
        expect(documentBeforeEntity(document([{ kind: "text", text: "plain" }]), "barrier")).toBeUndefined()
    })
})
