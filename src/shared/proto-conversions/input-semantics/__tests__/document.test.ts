import type { SemanticInputDocument } from "@shared/input-semantics/document"
import {
    SemanticInputDocument as WireDocument,
    SemanticInputNode as WireNode,
    SemanticEntityState as WireState,
} from "@shared/proto/dline/input"
import { describe, expect, it } from "vitest"
import { fromProtoSemanticInputDocument, toProtoSemanticInputDocument } from "../document"

const document: SemanticInputDocument = {
    schemaVersion: 1,
    parserVersion: "1.0.0",
    catalogRevision: "7",
    documentId: "doc-1",
    rawText: "/compact compare [image:r1] with [file:r2] @/src/index.ts",
    nodes: [
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
        { kind: "image", entityId: "e2", resourceId: "r1", displayName: "before.png", altText: "before" },
        { kind: "text", text: " with " },
        {
            kind: "file",
            entityId: "e3",
            resourceId: "r2",
            fileOrigin: "pasted_text",
            displayName: "input.txt",
            lineCount: 42,
        },
        {
            kind: "mention",
            entityId: "e4",
            mentionKind: "file",
            sourceText: "@/src/index.ts",
            canonicalRef: "src/index.ts",
            workspaceHint: "root-a",
            capturePolicy: "snapshot_at_submit",
            state: "recognized",
        },
    ],
    resources: [
        { resourceId: "r1", expectedContentHash: "hash-1" },
        { resourceId: "r2", expectedContentHash: "hash-2" },
    ],
}

describe("semantic input document proto conversion", () => {
    it("round-trips every node kind, order, optional field and resource binding", () => {
        const result = fromProtoSemanticInputDocument(toProtoSemanticInputDocument(document))

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.document).toEqual(document)
    })

    it("omits an absent optional instead of inventing a default", () => {
        const minimal: SemanticInputDocument = {
            ...document,
            nodes: [{ kind: "image", entityId: "e2", resourceId: "r1", displayName: "before.png" }],
            resources: [{ resourceId: "r1", expectedContentHash: "hash-1" }],
        }

        const result = fromProtoSemanticInputDocument(toProtoSemanticInputDocument(minimal))

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.document.nodes[0]).not.toHaveProperty("altText")
    })

    it("rejects an unsupported schema version", () => {
        const wire = toProtoSemanticInputDocument(document)
        wire.schemaVersion = 2

        const result = fromProtoSemanticInputDocument(wire)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostic.code).toBe("semantic_input_schema_unsupported")
        expect(result.diagnostic.documentId).toBe("doc-1")
    })

    it("fails closed on a node with no payload, instead of dropping it", () => {
        const wire = WireDocument.create({ ...toProtoSemanticInputDocument(document), nodes: [WireNode.create({})] })

        const result = fromProtoSemanticInputDocument(wire)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostic.code).toBe("semantic_input_node_invalid")
    })

    it("fails closed on an entity state this build cannot interpret, and names the node", () => {
        const wire = toProtoSemanticInputDocument(document)
        const slashCommand = wire.nodes[0].slashCommand
        if (!slashCommand) throw new Error("the first node must be a slash command")
        slashCommand.state = WireState.UNRECOGNIZED

        const result = fromProtoSemanticInputDocument(wire)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostic.code).toBe("semantic_input_node_invalid")
        expect(result.diagnostic.entityId).toBe("e1")
    })
})
