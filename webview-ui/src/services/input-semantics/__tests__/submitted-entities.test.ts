import { SEMANTIC_INPUT_SCHEMA_VERSION } from "@shared/input-semantics/document"
import type { SubmittedInputFacts } from "@shared/input-semantics/submitted-input"
import { describe, expect, it } from "vitest"
import { markDocumentResources, markSubmittedEntities, parseSubmittedEntityLink } from "../highlight"

const facts = (...segments: SubmittedInputFacts["segments"]): SubmittedInputFacts[] => [{ segments }]

describe("markSubmittedEntities", () => {
    it("marks the entities that ran and keeps the rest of the Markdown verbatim", () => {
        const text = "/compact\n```\n/not-a-command\n```"
        const marked = markSubmittedEntities(
            text,
            facts(
                { text: "/compact", role: "command", active: true },
                { text: "\n```\n/not-a-command\n```", role: "text", active: false },
            ),
        )
        expect(marked).toBe("[/compact](#dline-entity/command/%2Fcompact)\n```\n/not-a-command\n```")
    })

    it("escapes Markdown syntax inside an entity so the link text reads as written", () => {
        const marked = markSubmittedEntities("@/src/a_[1].ts", facts({ text: "@/src/a_[1].ts", role: "mention", active: true }))
        expect(marked).toBe("[@/src/a\\_\\[1\\].ts](#dline-entity/mention/%40%2Fsrc%2Fa_%5B1%5D.ts)")
        expect(parseSubmittedEntityLink("#dline-entity/mention/%40%2Fsrc%2Fa_%5B1%5D.ts")).toEqual({
            role: "mention",
            text: "@/src/a_[1].ts",
        })
    })

    // A row whose only entity is an attachment still draws it as a chip.
    it("marks a resource by its segment position and its display name", () => {
        const text = "see [a_b.png]"
        const marked = markSubmittedEntities(
            text,
            facts({ text: "see ", role: "text", active: false }, { text: "[a_b.png]", role: "resource", active: true }),
        )
        expect(marked).toBe("see [a\\_b.png](#dline-entity/resource/1/a_b.png)")
        expect(parseSubmittedEntityLink("#dline-entity/resource/1/a_b.png")).toEqual({
            role: "resource",
            key: "1",
            text: "a_b.png",
        })
    })

    it.each([
        ["a legacy row", "/compact", undefined],
        ["facts that do not spell the text", "/compact now", facts({ text: "/compact", role: "command", active: true })],
        ["a row whose entities did not run", "/compact", facts({ text: "/compact", role: "command", active: false })],
    ])("leaves %s to the plain text", (_label, text, inputs) => {
        expect(markSubmittedEntities(text, inputs)).toBeUndefined()
    })
})

describe("markDocumentResources", () => {
    it("marks each resource by its entity id and keeps every other node as the entry reads", () => {
        const marked = markDocumentResources({
            schemaVersion: SEMANTIC_INPUT_SCHEMA_VERSION,
            parserVersion: "test",
            catalogRevision: "test",
            documentId: "doc-1",
            rawText: "",
            nodes: [
                { kind: "text", text: "compare " },
                { kind: "image", entityId: "e/1", resourceId: "r-1", displayName: "a [1].png" },
                { kind: "text", text: " and **this**" },
            ],
            resources: [],
        })

        expect(marked).toBe("compare [a \\[1\\].png](#dline-entity/resource/e%2F1/a%20%5B1%5D.png) and **this**")
        expect(parseSubmittedEntityLink("#dline-entity/resource/e%2F1/a%20%5B1%5D.png")).toEqual({
            role: "resource",
            key: "e/1",
            text: "a [1].png",
        })
    })
})

describe("parseSubmittedEntityLink", () => {
    it.each([
        undefined,
        "https://example.com",
        "#dline-entity/resource/x",
        "#dline-entity/resource/x/y/z",
        "#dline-entity/command/%E0%A4%A",
        "#dline-entity/resource/1/%E0%A4%A",
    ])("ignores %s", (href) => {
        expect(parseSubmittedEntityLink(href)).toBeUndefined()
    })
})
