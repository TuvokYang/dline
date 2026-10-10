import { describe, expect, it } from "vitest"
import type { SemanticInputDocument } from "../document"
import { documentMatchesPresentation, presentationTextOf } from "../presentation"

const nodes: SemanticInputDocument["nodes"] = [
    {
        kind: "slash_command",
        entityId: "e1",
        commandId: "command.compact",
        sourceText: "/compact",
        canonicalName: "compact",
        namespace: "cmd",
        compositionMode: "lifecycle_barrier",
        state: "recognized",
    },
    { kind: "text", text: " compare " },
    { kind: "image", entityId: "e2", resourceId: "r1", displayName: "before.png" },
    { kind: "text", text: " with " },
    { kind: "file", entityId: "e3", resourceId: "r2", fileOrigin: "pasted_text", displayName: "input.txt" },
]

function document(rawText: string): SemanticInputDocument {
    return {
        schemaVersion: 1,
        parserVersion: "1.0.0",
        catalogRevision: "3",
        documentId: "doc-1",
        rawText,
        nodes,
        resources: [
            {
                resourceId: "r1",
                expectedContentHash: "hash-1",
                mediaType: "image/png",
                byteLength: 10,
                owner: { kind: "task", taskId: "task-1" },
                generation: 1,
            },
            {
                resourceId: "r2",
                expectedContentHash: "hash-2",
                mediaType: "text/plain",
                byteLength: 10,
                owner: { kind: "task", taskId: "task-1" },
                generation: 1,
            },
        ],
    }
}

describe("semantic input presentation", () => {
    it("projects nodes in order and addresses resources by stable id", () => {
        expect(presentationTextOf(document(""))).toBe("/compact compare [image:r1] with [file:r2]")
    })

    it("confirms a raw text that still matches the ordered nodes", () => {
        expect(documentMatchesPresentation(document("/compact compare [image:r1] with [file:r2]"))).toBe(true)
    })

    it("detects raw text that drifted from the nodes", () => {
        expect(documentMatchesPresentation(document("/compact compare both files"))).toBe(false)
    })
})
