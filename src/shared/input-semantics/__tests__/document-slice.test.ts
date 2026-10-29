import { describe, expect, it } from "vitest"
import type { SemanticInputDocument, SemanticResourceRef } from "../document"
import { documentKeptByTurn } from "../document-slice"
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

describe("documentKeptByTurn", () => {
    it("keeps the nodes in front of the barrier and only the resources they reference", () => {
        const source = document([
            { kind: "text", text: "  compare " },
            { kind: "image", entityId: "e1", resourceId: "r1", displayName: "before.png" },
            { kind: "text", text: " then " },
            compact,
            { kind: "text", text: " keep the audit" },
        ])

        const prefix = documentKeptByTurn(source, "barrier")

        expect(prefix?.nodes).toEqual([
            { kind: "text", text: "compare " },
            { kind: "image", entityId: "e1", resourceId: "r1", displayName: "before.png" },
            { kind: "text", text: " then" },
        ])
        // The guidance after the barrier belongs to the command, not the kept submission.
        expect(prefix?.resources.map((ref) => ref.resourceId)).toEqual(["r1"])
        expect(prefix?.rawText).toBe("compare [image:r1] then")
        expect(prefix?.documentId).toBe(source.documentId)
        // The slice is still a document the admission boundary accepts as-is.
        expect(prefix && validateSemanticInputDocument(prefix)).toEqual([])
    })

    // A resource after the barrier is an attachment of the turn, not guidance
    // for the command, so it stays in the kept document after the earlier nodes.
    it("keeps a resource placed after the barrier and drops the guidance around it", () => {
        const source = document([
            { kind: "text", text: "compare " },
            compact,
            { kind: "text", text: " keep " },
            { kind: "file", entityId: "e2", resourceId: "r2", fileOrigin: "pasted_text", displayName: "notes.txt" },
            { kind: "text", text: " the audit" },
        ])

        const kept = documentKeptByTurn(source, "barrier")

        expect(kept?.nodes).toEqual([
            { kind: "text", text: "compare " },
            { kind: "file", entityId: "e2", resourceId: "r2", fileOrigin: "pasted_text", displayName: "notes.txt" },
        ])
        expect(kept?.resources.map((ref) => ref.resourceId)).toEqual(["r2"])
        expect(kept?.rawText).toBe("compare [file:r2]")
        expect(kept && validateSemanticInputDocument(kept)).toEqual([])
    })

    it("yields an empty document when the entity opens the input", () => {
        const prefix = documentKeptByTurn(document([compact, { kind: "text", text: " keep the audit" }]), "barrier")

        expect(prefix?.nodes).toEqual([])
        expect(prefix?.resources).toEqual([])
        expect(prefix?.rawText).toBe("")
    })

    it("drops whitespace-only edge text instead of keeping an empty node", () => {
        const prefix = documentKeptByTurn(
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
        expect(documentKeptByTurn(document([{ kind: "text", text: "plain" }]), "barrier")).toBeUndefined()
    })
})
