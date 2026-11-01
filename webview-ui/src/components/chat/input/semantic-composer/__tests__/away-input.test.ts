import { BUILTIN_INPUT_SEMANTICS } from "@shared/input-semantics/catalog"
import type { SemanticResourceRef } from "@shared/input-semantics/document"
import { documentMatchesPresentation } from "@shared/input-semantics/presentation"
import { InputSemanticCatalog as WireCatalog } from "@shared/proto/dline/slash"
import { fromProtoInputSemanticCatalog, toProtoInputSemanticCatalog } from "@shared/proto-conversions/input-semantics/catalog"
import { describe, expect, it } from "vitest"
import { createCommandAtom, createMentionAtom } from "../atoms"
import type { ComposerSegment, ComposerTextSource } from "../model"
import { composeComposerSubmission } from "../projection"

const wire = toProtoInputSemanticCatalog({ revision: 9, descriptors: BUILTIN_INPUT_SEMANTICS })
const catalog = fromProtoInputSemanticCatalog(WireCatalog.decode(WireCatalog.encode(wire).finish()))
const context = { catalog, documentId: "away-composer" }
const text = (value: string, source: ComposerTextSource = "typed"): ComposerSegment => ({ kind: "text", text: value, source })
const resource: SemanticResourceRef = {
    resourceId: "image",
    expectedContentHash: "a".repeat(64),
    mediaType: "image/png",
    byteLength: 5,
    owner: { kind: "draft", draftId: "draft" },
    generation: 1,
}

describe("Away submission preprocessing", () => {
    it("canonicalizes a typed token without shifting mixed-source text, mentions or resources", () => {
        const mention = createMentionAtom(catalog, "/src/a.ts")!
        const submitted = composeComposerSubmission(
            [
                text("/away fix "),
                { kind: "atom", atom: mention },
                text(" /away ", "pasted"),
                {
                    kind: "atom",
                    atom: {
                        kind: "resource",
                        entityId: "image-node",
                        nodeKind: "image",
                        fileOrigin: "pasted_file",
                        displayName: "shot.png",
                        status: "ready",
                        ref: resource,
                    },
                },
            ],
            context,
        )
        const doc = submitted.semanticInput!
        expect(doc.nodes.map((node) => node.kind)).toEqual([
            "slash_command",
            "text",
            "mention",
            "text",
            "slash_command",
            "text",
            "image",
        ])
        expect(doc.nodes[0]).toMatchObject({
            commandId: "command.away",
            sourceText: "/cmd:away",
            compositionMode: "composable",
            state: "recognized",
        })
        expect(doc.nodes[1]).toEqual({ kind: "text", text: " fix " })
        expect(doc.nodes[2]).toMatchObject({ entityId: mention.entityId, canonicalRef: "/src/a.ts", state: "recognized" })
        expect(doc.nodes[4]).toMatchObject({ sourceText: "/away", state: "unresolved" })
        expect(doc.nodes[5]).toEqual({ kind: "text", text: " " })
        expect(doc.nodes[6]).toMatchObject({ kind: "image", resourceId: "image" })
        expect(doc.resources).toEqual([resource])
        expect(documentMatchesPresentation(doc)).toBe(true)
        expect(submitted.text).toBe(doc.rawText)
        // Ranges remain editor coordinates, not coordinates in the longer canonical spelling.
        expect(submitted.projection.entities[0].range).toEqual({ start: 0, end: 5 })
    })

    it("uses the same composable policy for a real menu atom and typed input", () => {
        const command = createCommandAtom(catalog, "command.away", "/cmd:away")!
        expect(command.compositionMode).toBe("composable")
        const menu = composeComposerSubmission([{ kind: "atom", atom: command }, text(" continue")], context)
        const typed = composeComposerSubmission([text("/away continue")], context)
        expect(menu.text).toBe("/cmd:away continue")
        expect(typed.text).toBe(menu.text)
        expect(menu.semanticInput?.nodes[0]).toMatchObject({ sourceText: "/cmd:away", commandId: "command.away" })
    })

    it("never normalizes a pasted candidate or opaque source", () => {
        const pasted = composeComposerSubmission([text("/away continue", "pasted")], context)
        expect(pasted.text).toBe("/away continue")
        expect(pasted.semanticInput?.nodes[0]).toMatchObject({ state: "unresolved", sourceText: "/away" })
        const opaque = composeComposerSubmission([text("/away continue", "editor_selection")], context)
        expect(opaque.semanticInput?.nodes).toEqual([{ kind: "literal", text: "/away continue", source: "editor_selection" }])
    })
})
