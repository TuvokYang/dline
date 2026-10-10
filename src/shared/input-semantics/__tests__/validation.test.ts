import { describe, expect, it } from "vitest"
import type { SemanticInputDocument, SemanticInputNode, SemanticResourceRef } from "../document"
import { validateSemanticInputDocument } from "../validation"

function ref(resourceId: string, expectedContentHash: string, mediaType = "image/png"): SemanticResourceRef {
    return {
        resourceId,
        expectedContentHash,
        mediaType,
        byteLength: 10,
        owner: { kind: "task", taskId: "task-1" },
        generation: 1,
    }
}

function document(
    nodes: readonly SemanticInputNode[],
    resources: readonly SemanticResourceRef[] = [],
    overrides: Partial<SemanticInputDocument> = {},
): SemanticInputDocument {
    return {
        schemaVersion: 1,
        parserVersion: "1.0.0",
        catalogRevision: "3",
        documentId: "doc-1",
        rawText: "",
        nodes,
        resources,
        ...overrides,
    }
}

const compact: SemanticInputNode = {
    kind: "slash_command",
    entityId: "e1",
    commandId: "command.compact",
    sourceText: "/compact",
    canonicalName: "compact",
    namespace: "cmd",
    compositionMode: "lifecycle_barrier",
    state: "recognized",
}

function codes(diagnostics: readonly { code: string }[]): string[] {
    return diagnostics.map((diagnostic) => diagnostic.code)
}

describe("validateSemanticInputDocument", () => {
    it("accepts a consistent document", () => {
        const doc = document(
            [
                compact,
                { kind: "text", text: " then this" },
                { kind: "image", entityId: "e2", resourceId: "r1", displayName: "shot.png" },
            ],
            [ref("r1", "hash-1")],
        )

        expect(validateSemanticInputDocument(doc)).toEqual([])
    })

    it("rejects an unsupported schema version and a missing envelope identity", () => {
        const doc = document([], [], {
            schemaVersion: 2 as SemanticInputDocument["schemaVersion"],
            documentId: "",
            parserVersion: "",
            catalogRevision: "",
        })

        expect(codes(validateSemanticInputDocument(doc))).toEqual([
            "semantic_input_schema_unsupported",
            "semantic_input_schema_unsupported",
            "semantic_input_parser_unsupported",
            "semantic_input_catalog_stale",
        ])
    })

    it("locates a node that has no stable identity", () => {
        const doc = document([{ ...compact, entityId: "" }])

        const [diagnostic] = validateSemanticInputDocument(doc)

        expect(diagnostic.code).toBe("semantic_input_node_invalid")
        expect(diagnostic.documentId).toBe("doc-1")
    })

    it("keeps an unrecognized command shape submittable, because it is content and not intent", () => {
        const doc = document([
            {
                kind: "slash_command",
                entityId: "e1",
                commandId: "",
                sourceText: "/skills:not-installed",
                canonicalName: "skills:not-installed",
                namespace: "cmd",
                compositionMode: "composable",
                state: "unresolved",
            },
        ])

        expect(validateSemanticInputDocument(doc)).toEqual([])
    })

    it("rejects an active command that carries no catalog identity", () => {
        const doc = document([{ ...compact, commandId: "" }])

        expect(codes(validateSemanticInputDocument(doc))).toEqual(["semantic_input_node_invalid"])
    })

    it("rejects a reused entity id, because editing and queueing address nodes by identity", () => {
        const doc = document([compact, { ...compact, compositionMode: "composable" }])

        expect(codes(validateSemanticInputDocument(doc))).toContain("semantic_input_node_invalid")
    })

    it("rejects a second lifecycle barrier", () => {
        const doc = document([compact, { ...compact, entityId: "e2", commandId: "command.new_task", canonicalName: "newtask" }])

        expect(codes(validateSemanticInputDocument(doc))).toContain("semantic_input_lifecycle_barrier_invalid")
    })

    it("counts only a recognized barrier, so a literal command stays content", () => {
        const doc = document([compact, { ...compact, entityId: "e2", state: "literal" }])

        expect(codes(validateSemanticInputDocument(doc))).not.toContain("semantic_input_lifecycle_barrier_invalid")
    })

    it("reports a resource node with no frozen hash binding", () => {
        const doc = document([
            { kind: "file", entityId: "e1", resourceId: "r1", fileOrigin: "pasted_text", displayName: "input.txt" },
        ])

        const [diagnostic] = validateSemanticInputDocument(doc)

        expect(diagnostic.code).toBe("semantic_input_resource_missing")
        expect(diagnostic.resourceId).toBe("r1")
    })

    it("reports a binding that no node references and a binding without a hash", () => {
        const doc = document([], [ref("r1", "")])

        expect(codes(validateSemanticInputDocument(doc))).toEqual([
            "semantic_input_resource_invalid",
            "semantic_input_resource_invalid",
        ])
    })
})
