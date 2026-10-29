import { describe, expect, it } from "vitest"
import type { SemanticInputDocument, SemanticInputNode, SemanticResourceRef } from "../document"
import { describeResourcePresentation, presentationTextOf } from "../presentation"
import { validateSemanticInputDocument } from "../validation"

function ref(resourceId: string, overrides: Partial<SemanticResourceRef> = {}): SemanticResourceRef {
    return {
        resourceId,
        expectedContentHash: `hash-${resourceId}`,
        mediaType: "text/plain",
        byteLength: 12,
        owner: { kind: "task", taskId: "task-1" },
        generation: 1,
        ...overrides,
    }
}

function document(nodes: readonly SemanticInputNode[], resources: readonly SemanticResourceRef[] = []): SemanticInputDocument {
    const draft: SemanticInputDocument = {
        schemaVersion: 1,
        parserVersion: "1.0.0",
        catalogRevision: "3",
        documentId: "doc-1",
        rawText: "",
        nodes,
        resources,
    }
    return { ...draft, rawText: presentationTextOf(draft) }
}

describe("semantic input contract: version 1 compatibility", () => {
    it("still accepts a document persisted before literals and resource references existed", () => {
        // The JSON shape released builds wrote into queue snapshots: text, command and mention nodes, no resources.
        const persisted = JSON.parse(`{
            "schemaVersion": 1,
            "parserVersion": "1.0.0",
            "catalogRevision": "3",
            "documentId": "doc-released",
            "rawText": "/compact then read @/src/app.ts",
            "nodes": [
                {
                    "kind": "slash_command",
                    "entityId": "e1",
                    "commandId": "command.compact",
                    "sourceText": "/compact",
                    "canonicalName": "compact",
                    "namespace": "cmd",
                    "compositionMode": "lifecycle_barrier",
                    "state": "recognized"
                },
                { "kind": "text", "text": " then read " },
                {
                    "kind": "mention",
                    "entityId": "e2",
                    "mentionKind": "file",
                    "sourceText": "@/src/app.ts",
                    "canonicalRef": "/src/app.ts",
                    "state": "recognized"
                }
            ],
            "resources": []
        }`) as SemanticInputDocument

        expect(validateSemanticInputDocument(persisted)).toEqual([])
        expect(presentationTextOf(persisted)).toBe(persisted.rawText)
    })
})

describe("semantic input contract: literal content", () => {
    it("accepts opaque literal text without an entity identity", () => {
        const doc = document([
            { kind: "text", text: "explain " },
            { kind: "literal", text: "/compact @src/a.ts", source: "editor_selection" },
        ])

        expect(validateSemanticInputDocument(doc)).toEqual([])
        expect(doc.rawText).toBe("explain /compact @src/a.ts")
    })

    it("rejects a literal whose provenance this build does not know", () => {
        const doc = document([{ kind: "literal", text: "x", source: "clipboard" as never }])

        expect(validateSemanticInputDocument(doc).map((diagnostic) => diagnostic.code)).toEqual(["semantic_input_node_invalid"])
    })
})

describe("semantic input contract: resource references", () => {
    const pdf: SemanticInputNode = {
        kind: "file",
        entityId: "e1",
        resourceId: "r1",
        fileOrigin: "uploaded_file",
        displayName: "spec.pdf",
    }

    it("accepts a fully described task-owned and draft-owned resource", () => {
        const image: SemanticInputNode = { kind: "image", entityId: "e2", resourceId: "r2", displayName: "shot.png" }
        const doc = document(
            [pdf, image],
            [
                ref("r1", { mediaType: "application/pdf" }),
                ref("r2", { mediaType: "image/png", owner: { kind: "draft", draftId: "draft-7" }, generation: 2 }),
            ],
        )

        expect(validateSemanticInputDocument(doc)).toEqual([])
    })

    it("rejects an image node bound to content that is not an image", () => {
        const doc = document(
            [{ kind: "image", entityId: "e2", resourceId: "r2", displayName: "shot.png" }],
            [ref("r2", { mediaType: "application/pdf" })],
        )

        const diagnostics = validateSemanticInputDocument(doc)

        expect(diagnostics).toEqual([expect.objectContaining({ code: "semantic_input_resource_invalid_mime", resourceId: "r2" })])
    })

    it.each([
        ["an empty media type", { mediaType: "" }],
        ["a negative size", { byteLength: -1 }],
        ["a fractional size", { byteLength: 1.5 }],
        ["a generation below one", { generation: 0 }],
        ["an owner without an id", { owner: { kind: "task", taskId: "" } as const }],
        ["an unknown owner kind", { owner: { kind: "workspace", taskId: "t" } as never }],
    ])("rejects a reference with %s", (_label, overrides) => {
        const doc = document([pdf], [ref("r1", { mediaType: "application/pdf", ...overrides })])

        const diagnostics = validateSemanticInputDocument(doc)

        expect(diagnostics.length).toBeGreaterThan(0)
        expect(diagnostics.every((diagnostic) => diagnostic.resourceId === "r1")).toBe(true)
    })
})

describe("semantic input contract: resource presentation", () => {
    function file(displayName: string, mediaType = "application/octet-stream") {
        const node = {
            kind: "file",
            entityId: "e1",
            resourceId: "r1",
            fileOrigin: "uploaded_file",
            displayName,
        } as const
        return describeResourcePresentation(node, ref("r1", { mediaType }))
    }

    it.each([
        ["report.pdf", "pdf", "PDF"],
        ["input_1.txt", "text", "TXT"],
        ["server.log", "text", "LOG"],
        ["README.md", "text", "MD"],
        ["brief.docx", "document", "DOCX"],
        ["budget.xlsx", "spreadsheet", "XLSX"],
        ["analysis.ipynb", "notebook", "IPYNB"],
        ["rows.csv", "data", "CSV"],
        ["config.json", "data", "JSON"],
        ["feed.xml", "data", "XML"],
        ["main.ts", "code", "TS"],
        ["archive.weird", "file", "WEIRD"],
        ["no-extension", "file", "FILE"],
    ])("describes %s as %s with badge %s", (name, visualKind, badge) => {
        expect(file(name)).toEqual({ visualKind, formatBadge: badge })
    })

    it("falls back to the verified media type when the name carries no extension", () => {
        expect(file("scan", "application/pdf")).toEqual({ visualKind: "pdf", formatBadge: "PDF" })
    })

    it("lets a specific verified media type win over a misleading name", () => {
        expect(file("notes.txt", "application/pdf")).toEqual({ visualKind: "pdf", formatBadge: "PDF" })
    })

    it("ignores media type parameters and case", () => {
        expect(file("scan", "Application/PDF; charset=binary")).toEqual({ visualKind: "pdf", formatBadge: "PDF" })
    })

    it("lets the name decide when the verified media type is generic", () => {
        expect(file("main.ts", "text/plain")).toEqual({ visualKind: "code", formatBadge: "TS" })
        expect(file("notes", "text/plain")).toEqual({ visualKind: "text", formatBadge: "TXT" })
    })

    it("describes an image node as an image whatever its name says", () => {
        const node = { kind: "image", entityId: "e1", resourceId: "r1", displayName: "photo.jpeg" } as const
        expect(describeResourcePresentation(node, ref("r1", { mediaType: "image/jpeg" }))).toEqual({
            visualKind: "image",
            formatBadge: "JPEG",
        })
    })

    it("bounds a hostile extension so a badge cannot carry arbitrary text", () => {
        const described = file("x.<script>alert(1)</script>")
        expect(described.formatBadge).toMatch(/^[A-Z0-9-]{1,8}$/)
    })
})
