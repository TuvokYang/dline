import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import type { SemanticResourceRef } from "@shared/input-semantics/document"
import { documentMatchesPresentation } from "@shared/input-semantics/presentation"
import { validateSemanticInputDocument } from "@shared/input-semantics/validation"
import { describe, expect, it } from "vitest"
import { createCommandAtom, createMentionAtom } from "../atoms"
import type { ComposerAtom, ComposerSegment, ComposerTextSource, ResourceAtom } from "../model"
import { composeComposerSubmission, composerTriggerAt, projectComposerDocument } from "../projection"
import { segmentsForRecalledDraft, segmentsFromDocument } from "../restore"

const catalog: InputSemanticCatalog = { revision: 3, descriptors: BUILTIN_INPUT_SEMANTICS }
const context = { catalog, documentId: "doc-1" }

const text = (value: string, source: ComposerTextSource = "typed"): ComposerSegment => ({ kind: "text", text: value, source })
const atom = (value: ComposerAtom): ComposerSegment => ({ kind: "atom", atom: value })

const ref: SemanticResourceRef = {
    resourceId: "res-1",
    expectedContentHash: "a".repeat(64),
    mediaType: "image/png",
    byteLength: 10,
    owner: { kind: "draft", draftId: "00000000-0000-4000-8000-000000000000" },
    generation: 1,
}

const readyImage: ResourceAtom = {
    kind: "resource",
    entityId: "img-1",
    nodeKind: "image",
    fileOrigin: "pasted_file",
    displayName: "shot.png",
    status: "ready",
    ref,
}

function compactAtom(): ComposerAtom {
    const command = createCommandAtom(catalog, "command.compact", "/compact")
    if (!command) throw new Error("the built-in catalog must know /compact")
    return command
}

describe("projectComposerDocument", () => {
    it("activates typed commands and sends no document for typed text alone", () => {
        const projection = projectComposerDocument([text("/compact now")], context)
        expect(projection.document.nodes[0]).toMatchObject({ kind: "slash_command", state: "recognized" })
        expect(projection.requiresDocument).toBe(false)
        expect(composeComposerSubmission([text("/compact now")], context).semanticInput).toBeUndefined()
    })

    it("holds a pasted candidate and then needs the document", () => {
        const projection = projectComposerDocument([text("see "), text("/compact", "pasted")], context)
        expect(projection.document.nodes.find((node) => node.kind === "slash_command")).toMatchObject({ state: "unresolved" })
        expect(projection.requiresDocument).toBe(true)
    })

    it("keeps an editor selection literal whatever it contains", () => {
        const projection = projectComposerDocument([text("fix "), text("/compact @/etc/passwd", "editor_selection")], context)
        expect(projection.document.nodes).toEqual([
            { kind: "text", text: "fix " },
            { kind: "literal", text: "/compact @/etc/passwd", source: "editor_selection" },
        ])
        expect(projection.entities).toEqual([])
    })

    it("places atoms in draft order with their own identities", () => {
        const command = compactAtom()
        const mention = createMentionAtom(catalog, "/src/a.ts")
        if (!mention) throw new Error("the built-in catalog must know file mentions")
        const segments = [atom(command), text(" keep "), atom(readyImage), text(" and "), atom(mention), text(" ")]
        const { document, entities, requiresDocument } = projectComposerDocument(segments, context)

        expect(document.nodes.map((node) => node.kind)).toEqual(["slash_command", "text", "image", "text", "mention", "text"])
        expect(document.nodes[0]).toMatchObject({ entityId: command.entityId, state: "recognized" })
        expect(document.resources).toEqual([ref])
        expect(entities.map((entity) => entity.range)).toEqual([
            { start: 0, end: 1 },
            { start: 13, end: 14 },
        ])
        expect(requiresDocument).toBe(true)
        expect(documentMatchesPresentation(document)).toBe(true)
        expect(validateSemanticInputDocument(document)).toEqual([])
    })

    it("does not let a typed token absorb an adjacent atom", () => {
        const mention = createMentionAtom(catalog, "/src/a.ts")
        if (!mention) throw new Error("mention expected")
        // "/compact" directly followed by an atom is not a complete command token.
        const projection = projectComposerDocument([text("/compact"), atom(mention)], context)
        expect(projection.document.nodes[0]).toEqual({ kind: "text", text: "/compact" })
    })

    it("keeps code opaque across atoms", () => {
        const segments = [text("```\n"), atom(readyImage), text("\n/compact\n```")]
        const projection = projectComposerDocument(segments, context)
        expect(projection.document.nodes.some((node) => node.kind === "slash_command")).toBe(false)
    })

    it("reports resources that cannot be sent yet", () => {
        const staging: ResourceAtom = { ...readyImage, entityId: "img-2", status: "staging", ref: undefined }
        const failed: ResourceAtom = {
            ...readyImage,
            entityId: "img-3",
            status: "failed",
            ref: undefined,
            error: { code: "semantic_input_resource_too_large", message: "too large" },
        }
        const projection = projectComposerDocument([atom(staging), atom(failed)], context)
        expect(projection.stagingResources).toEqual(["img-2"])
        expect(projection.failedResources).toEqual(["img-3"])
    })

    it("prefixes a quote as a literal the user did not type", () => {
        const submission = composeComposerSubmission([text("ok")], { ...context, literalPrefix: "> /compact\n" })
        expect(submission.text).toBe("> /compact\nok")
        expect(submission.semanticInput?.nodes[0]).toEqual({ kind: "literal", text: "> /compact\n", source: "app_action" })
    })
})

describe("composerTriggerAt", () => {
    it("finds the trigger the caret is completing", () => {
        expect(composerTriggerAt([text("run /com")], 8)).toEqual({ kind: "command", start: 4, query: "com" })
    })

    it("opens no menu inside literal text", () => {
        expect(composerTriggerAt([text("/com", "editor_selection")], 4)).toBeUndefined()
    })
})

describe("restoring a draft", () => {
    it("brings recognized entities and resources back as atoms and the rest as held text", () => {
        const command = compactAtom()
        const segments = [atom(command), text(" keep "), atom(readyImage), text(" "), text("/compact", "pasted")]
        const { document } = projectComposerDocument(segments, context)

        const restored = segmentsFromDocument(document)
        expect(restored[0]).toEqual(atom(command))
        expect(restored[2]).toEqual(atom(readyImage))
        // The held candidate stays held after the round trip.
        expect(restored[3]).toEqual(text(" /compact", "restored"))
        const again = projectComposerDocument(restored, context)
        expect(again.document.nodes.find((node, index) => index > 0 && node.kind === "slash_command")).toMatchObject({
            state: "unresolved",
        })
    })

    it("keeps typed candidates of a text-only draft live and holds the rest", () => {
        const restored = segmentsForRecalledDraft("please /compact now")
        expect(restored).toEqual([text("please ", "restored"), text("/compact"), text(" now", "restored")])
    })

    it("marks a resource whose reference is missing as failed instead of dropping it", () => {
        const { document } = projectComposerDocument([atom(readyImage)], context)
        const restored = segmentsFromDocument({ ...document, resources: [] })
        expect(restored[0]).toMatchObject({ kind: "atom", atom: { status: "failed", entityId: "img-1" } })
    })
})
