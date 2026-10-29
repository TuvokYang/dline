import { describe, expect, it } from "vitest"
import { segmentSubmittedInputs } from "../highlight"

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

    it("keeps a resource as an entity, so the row draws the chip the composer showed", () => {
        expect(segmentSubmittedInputs([{ segments: [{ text: "[diagram.png]", role: "resource", active: true }] }])).toEqual([
            { text: "[diagram.png]", role: "resource", active: true },
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
