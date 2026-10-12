import { BUILTIN_INPUT_SEMANTICS, type InputSemanticCatalog } from "@shared/input-semantics/catalog"
import { describe, expect, it } from "vitest"
import { renderSemanticHighlightHtml, segmentSemanticInput, segmentSubmittedInputs } from "../highlight"

const catalog: InputSemanticCatalog = { revision: 1, descriptors: BUILTIN_INPUT_SEMANTICS }

describe("semantic composer highlight", () => {
    it("marks a recognized command and mention as entities", () => {
        expect(segmentSemanticInput("/compact @/src/index.ts", catalog)).toEqual([
            { text: "/compact", role: "command", active: true },
            { text: " ", role: "text", active: false },
            { text: "@/src/index.ts", role: "mention", active: true },
        ])
    })

    it("shows text after a lifecycle barrier as literal", () => {
        const segments = segmentSemanticInput("/compact then /explain-changes", catalog)

        expect(segments.filter((segment) => segment.role === "command")).toEqual([
            { text: "/compact", role: "command", active: true },
            { text: "/explain-changes", role: "command", active: false },
        ])
    })

    it("leaves an unknown command as plain text", () => {
        expect(renderSemanticHighlightHtml("/not-a-command", catalog)).toBe("/not-a-command")
    })

    it("escapes the text it renders", () => {
        expect(renderSemanticHighlightHtml("a < b & c", catalog)).toBe("a &lt; b &amp; c")
    })

    it("keeps a trailing newline visible in the layer", () => {
        expect(renderSemanticHighlightHtml("line\n", catalog)).toBe("line\n\n")
    })
})

describe("submitted input highlight", () => {
    it("draws exactly the entities the facts recorded", () => {
        expect(
            segmentSubmittedInputs([
                {
                    segments: [
                        { text: "/compact", role: "command", active: true },
                        { text: " then ", role: "text", active: false },
                        { text: "/explain-changes", role: "command", active: false },
                    ],
                },
            ]),
        ).toEqual([
            { text: "/compact", role: "command", active: true },
            { text: " then ", role: "text", active: false },
            { text: "/explain-changes", role: "command", active: false },
        ])
    })

    it("names a resource as plain text rather than an entity", () => {
        expect(segmentSubmittedInputs([{ segments: [{ text: "[diagram.png]", role: "resource", active: true }] }])).toEqual([
            { text: "[diagram.png]", role: "text", active: false },
        ])
    })

    it("separates the inputs of a batch the same way the row text does", () => {
        const segments = segmentSubmittedInputs([
            { segments: [{ text: "first", role: "text", active: false }] },
            { segments: [{ text: "@/src/a.ts", role: "mention", active: false }] },
        ])

        expect(segments?.map((segment) => segment.text).join("")).toBe("first\n\n@/src/a.ts")
        expect(segments).toContainEqual({ text: "@/src/a.ts", role: "mention", active: false })
    })

    it("has no segments for a legacy row, so the caller shows its plain text", () => {
        expect(segmentSubmittedInputs(undefined)).toBeUndefined()
        expect(segmentSubmittedInputs([])).toBeUndefined()
    })
})
