import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { describe, expect, it } from "vitest"
import { createCommandAtom } from "../atoms"
import { composerHighlights, HELD_CANDIDATE_CLASS, TYPED_ENTITY_CLASS } from "../highlights"
import type { ComposerSegment, ComposerTextSource } from "../model"
import { projectComposerDocument } from "../projection"

const CATALOG = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS } as unknown as InputSemanticCatalog

const text = (value: string, source: ComposerTextSource): ComposerSegment => ({ kind: "text", text: value, source })

function highlightsOf(segments: readonly ComposerSegment[]) {
    return composerHighlights(projectComposerDocument(segments, { catalog: CATALOG, documentId: "doc-h" }), CATALOG)
}

describe("composerHighlights", () => {
    it("has nothing to draw without a projection", () => {
        expect(composerHighlights(undefined, CATALOG)).toEqual({ decorations: [], heldCandidates: [] })
    })

    it("marks a typed command that will run", () => {
        expect(highlightsOf([text("/compact now", "typed")])).toEqual({
            decorations: [{ range: { start: 0, end: 8 }, className: TYPED_ENTITY_CLASS }],
            heldCandidates: [],
        })
    })

    it("marks a pasted command as held and names it for the notice", () => {
        expect(highlightsOf([text("run ", "typed"), text("/compact", "pasted")])).toEqual({
            decorations: [{ range: { start: 4, end: 12 }, className: HELD_CANDIDATE_CLASS }],
            heldCandidates: ["/compact"],
        })
    })

    it("leaves a slash word the catalog does not know undecorated", () => {
        expect(highlightsOf([text("/definitely-not-a-command", "typed")])).toEqual({ decorations: [], heldCandidates: [] })
        expect(highlightsOf([text("/definitely-not-a-command", "pasted")])).toEqual({ decorations: [], heldCandidates: [] })
    })

    it("does not decorate atoms, which draw themselves as chips", () => {
        const command = createCommandAtom(CATALOG, "command.compact", "/cmd:compact")
        if (!command) throw new Error("Expected the built-in compact command")

        expect(highlightsOf([{ kind: "atom", atom: command }])).toEqual({ decorations: [], heldCandidates: [] })
    })
})
