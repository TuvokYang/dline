import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog, type InputSemanticDescriptor } from "@shared/input-semantics/catalog"
import type { MentionInputNode } from "@shared/input-semantics/document"
import * as lexer from "@shared/input-semantics/lexer"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { LegacyInputAdapter } from "../LegacyInputAdapter"
import { SemanticInputAdmissionService } from "../SemanticInputAdmissionService"
import { TaskSemanticInputAdmission } from "../TaskSemanticInputAdmission"

vi.mock("@shared/input-semantics/lexer", async (importOriginal) => {
    const actual = await importOriginal<typeof import("@shared/input-semantics/lexer")>()
    return { ...actual, lexSemanticInput: vi.fn(actual.lexSemanticInput) }
})

const catalog: InputSemanticCatalog = { revision: 7, descriptors: BUILTIN_INPUT_SEMANTICS }
const RAW = "/explain-changes then read @/src/index.ts"

function harness() {
    const expand = vi.fn(async (_descriptor: InputSemanticDescriptor) => ({ text: "<instructions>" }))
    const resolve = vi.fn(async (_node: MentionInputNode) => "<resolved>")
    const admission = new TaskSemanticInputAdmission(
        new LegacyInputAdapter(
            async () => catalog,
            () => "doc-legacy",
        ),
        new SemanticInputAdmissionService({ catalog: () => catalog, commands: { expand }, mentions: { resolve } }),
    )
    return { admission, expand, resolve }
}

describe("TaskSemanticInputAdmission scanner budget", () => {
    const lex = vi.mocked(lexer.lexSemanticInput)

    beforeEach(() => {
        lex.mockClear()
    })

    it("admits a structured document without scanning its raw text", async () => {
        const document = lex(RAW, { catalog, documentId: "doc-1", activation: "auto" })
        lex.mockClear()
        const { admission, expand, resolve } = harness()

        const result = await admission.admit({ text: RAW, semanticInput: document })

        expect(result.ok).toBe(true)
        expect(lex).not.toHaveBeenCalled()
        // Each port sees one typed entity, never the submission's text.
        expect(expand.mock.calls.map(([descriptor]) => descriptor.id)).toEqual(["command.explain_changes"])
        expect(resolve.mock.calls.map(([node]) => [node.mentionKind, node.canonicalRef])).toEqual([["file", "/src/index.ts"]])
    })

    it("refuses resource nodes that arrive beside a flat attachment list", async () => {
        const base = lex("see", { catalog, documentId: "doc-mixed", activation: "auto" })
        const document = {
            ...base,
            nodes: [...base.nodes, { kind: "image" as const, entityId: "img-1", resourceId: "res-1", displayName: "a.png" }],
        }
        const { admission, expand, resolve } = harness()

        const result = await admission.admit({ text: "see", images: ["data:image/png;base64,AAAA"], semanticInput: document })

        expect(result.ok).toBe(false)
        expect(result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
            "semantic_input_resource_invalid",
        ])
        expect(expand).not.toHaveBeenCalled()
        expect(resolve).not.toHaveBeenCalled()
    })

    it("refuses a document whose visible text says something else", async () => {
        const document = lex("/compact now", { catalog, documentId: "doc-hidden", activation: "auto" })
        const { admission, expand } = harness()

        // The chat would show the harmless text while the document runs /compact.
        const result = await admission.admit({ text: "review this", semanticInput: document })

        expect(result.ok ? [] : result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
            "semantic_input_source_mismatch",
        ])
        expect(expand).not.toHaveBeenCalled()
    })

    it("lexes a legacy submission exactly once", async () => {
        const { admission, expand, resolve } = harness()

        const result = await admission.admit({ text: RAW })

        expect(result.ok).toBe(true)
        expect(lex).toHaveBeenCalledTimes(1)
        expect(expand).toHaveBeenCalledTimes(1)
        expect(resolve).toHaveBeenCalledTimes(1)
    })
})
