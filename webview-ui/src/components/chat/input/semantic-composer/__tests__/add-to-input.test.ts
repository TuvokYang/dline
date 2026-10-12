import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { describe, expect, it } from "vitest"
import { appendAddToInput } from "../add-to-input"
import { SemanticComposerEngine } from "../engine"
import { flatTextOf } from "../model"
import { composeComposerSubmission } from "../projection"

const catalog: InputSemanticCatalog = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS }
const selection = "\n```\n/compact now\n```"

function submitted(engine: SemanticComposerEngine) {
    return composeComposerSubmission(engine.getState().segments, { catalog, documentId: "doc-1" })
}

describe("appendAddToInput", () => {
    it("adds an editor selection as its file mention and one opaque selection literal", () => {
        const engine = new SemanticComposerEngine()

        appendAddToInput(engine, catalog, { text: `@/src/a.ts${selection}`, mentionReference: "/src/a.ts", selection })

        const nodes = submitted(engine).semanticInput?.nodes ?? []
        expect(nodes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: "mention", canonicalRef: "/src/a.ts" }),
                expect.objectContaining({ kind: "literal", text: selection, source: "editor_selection" }),
            ]),
        )
        // Code that reads like a command stays part of the selection.
        expect(nodes.some((node) => node.kind === "slash_command")).toBe(false)
    })

    it("puts the selection on its own line after an existing draft", () => {
        const engine = new SemanticComposerEngine()
        engine.apply({ type: "insert_text", text: "explain", source: "typed" })

        appendAddToInput(engine, catalog, { text: `@/src/a.ts${selection}`, mentionReference: "/src/a.ts", selection })

        expect(flatTextOf(engine.getState().segments).startsWith("explain\n")).toBe(true)
        expect(flatTextOf(engine.getState().segments).endsWith(`${selection}\n`)).toBe(true)
    })

    it("keeps plain text from other app actions as typed text", () => {
        const engine = new SemanticComposerEngine()

        appendAddToInput(engine, catalog, { text: "Terminal output:\n```\nok\n```" })

        expect(engine.getState().segments).toEqual([
            expect.objectContaining({ kind: "text", text: "Terminal output:\n```\nok\n```\n", source: "typed" }),
        ])
    })

    it("falls back to the plain text when the catalog cannot mention the file", () => {
        const engine = new SemanticComposerEngine()
        const withoutMentions = { revision: 1, descriptors: [] } as unknown as InputSemanticCatalog

        appendAddToInput(engine, withoutMentions, { text: `@/src/a.ts${selection}`, mentionReference: "/src/a.ts", selection })

        expect(flatTextOf(engine.getState().segments)).toBe(`@/src/a.ts${selection}\n`)
        expect(engine.getState().segments.every((segment) => segment.kind === "text" && segment.source === "typed")).toBe(true)
    })
})
