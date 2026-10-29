import type { SemanticInputDocument, SemanticResourceRef } from "@shared/input-semantics/document"
import {
    SemanticInputDocument as WireDocument,
    SemanticInputNode as WireNode,
    InputResourceOwner as WireOwner,
    SemanticResourceRef as WireResourceRef,
    InputSource as WireSource,
    SemanticEntityState as WireState,
} from "@shared/proto/dline/input"
import { describe, expect, it } from "vitest"
import { decodeAdmissibleSemanticInputDocument, fromProtoSemanticInputDocument, toProtoSemanticInputDocument } from "../document"

function ref(resourceId: string, overrides: Partial<SemanticResourceRef> = {}): SemanticResourceRef {
    return {
        resourceId,
        expectedContentHash: `hash-${resourceId.slice(1)}`,
        mediaType: "text/plain",
        byteLength: 64,
        owner: { kind: "task", taskId: "task-1" },
        generation: 1,
        ...overrides,
    }
}

const document: SemanticInputDocument = {
    schemaVersion: 1,
    parserVersion: "1.0.0",
    catalogRevision: "7",
    documentId: "doc-1",
    rawText: "/compact compare [image:r1] with [file:r2] @/src/index.ts see /not-a-command",
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
        { kind: "literal", text: " see /not-a-command", source: "editor_selection" },
    ],
    resources: [
        ref("r1", { mediaType: "image/png", owner: { kind: "draft", draftId: "draft-1" }, generation: 3 }),
        ref("r2", { byteLength: 6000 }),
    ],
}

describe("semantic input document proto conversion", () => {
    it("round-trips every node kind, order, optional field and resource reference", () => {
        const result = fromProtoSemanticInputDocument(toProtoSemanticInputDocument(document))

        expect(result.ok).toBe(true)
        if (!result.ok) return
        expect(result.document).toEqual(document)
    })

    it("omits an absent optional instead of inventing a default", () => {
        const minimal: SemanticInputDocument = {
            ...document,
            nodes: [{ kind: "image", entityId: "e2", resourceId: "r1", displayName: "before.png" }],
            resources: [ref("r1", { mediaType: "image/png" })],
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

    it("fails closed on a literal whose provenance this build cannot interpret", () => {
        const wire = toProtoSemanticInputDocument(document)
        const literal = wire.nodes[wire.nodes.length - 1].literal
        if (!literal) throw new Error("the last node must be a literal")
        literal.source = WireSource.UNRECOGNIZED

        const result = fromProtoSemanticInputDocument(wire)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostic.code).toBe("semantic_input_node_invalid")
    })

    it("rejects a literal whose provenance is missing instead of calling it typed", () => {
        const wire = toProtoSemanticInputDocument(document)
        const literal = wire.nodes[wire.nodes.length - 1].literal
        if (!literal) throw new Error("the last node must be a literal")
        literal.source = WireSource.INPUT_SOURCE_UNSPECIFIED

        const decodedFromBytes = fromProtoSemanticInputDocument(WireDocument.decode(WireDocument.encode(wire).finish()))

        expect(decodedFromBytes.ok).toBe(false)
        if (decodedFromBytes.ok) return
        expect(decodedFromBytes.diagnostic.code).toBe("semantic_input_node_invalid")
    })

    it("fails closed on a resource reference without an owner", () => {
        const wire = toProtoSemanticInputDocument(document)
        wire.resources[1].owner = undefined

        const result = fromProtoSemanticInputDocument(wire)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostic).toMatchObject({ code: "semantic_input_resource_invalid", resourceId: "r2" })
    })

    it("rejects an owner that claims both a draft and a task", () => {
        const wire = toProtoSemanticInputDocument(document)
        wire.resources[1].owner = WireOwner.create({ draftId: "draft-1", taskId: "task-1" })

        const result = fromProtoSemanticInputDocument(wire)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostic).toMatchObject({ code: "semantic_input_resource_invalid", resourceId: "r2" })
    })

    it("rejects a binding in the shape released builds never wrote: only an id and a hash", () => {
        const legacyBinding = WireResourceRef.encode(
            WireResourceRef.create({ resourceId: "r2", expectedContentHash: "hash-2" }),
        ).finish()
        const wire = toProtoSemanticInputDocument(document)
        wire.resources[1] = WireResourceRef.decode(legacyBinding)

        const result = fromProtoSemanticInputDocument(wire)

        expect(result.ok).toBe(false)
        if (result.ok) return
        expect(result.diagnostic).toMatchObject({ code: "semantic_input_resource_invalid", resourceId: "r2" })
    })

    it("admits only a document that also satisfies the document contract", () => {
        const forged = toProtoSemanticInputDocument({
            ...document,
            resources: document.resources.map((resource) => ({ ...resource, byteLength: -1 })),
        })

        expect(fromProtoSemanticInputDocument(forged).ok).toBe(true)
        const admitted = decodeAdmissibleSemanticInputDocument(forged)
        expect(admitted.ok).toBe(false)
        if (admitted.ok) return
        expect(admitted.diagnostic.code).toBe("semantic_input_resource_invalid")
        expect(decodeAdmissibleSemanticInputDocument(toProtoSemanticInputDocument(document)).ok).toBe(true)
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
