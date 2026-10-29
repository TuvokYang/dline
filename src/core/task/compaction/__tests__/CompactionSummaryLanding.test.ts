import { describe, expect, it } from "vitest"
import { readCompactionSummary } from "../CompactionSummaryLanding"

describe("readCompactionSummary", () => {
    it("reads a summary and the prose that carried it", () => {
        expect(readCompactionSummary({ summary: "condensed", assistantText: "here it is" })).toEqual({
            summary: "condensed",
            assistantText: "here it is",
        })
    })

    it("keeps the summary when no prose accompanied it", () => {
        expect(readCompactionSummary({ summary: "condensed" })).toEqual({ summary: "condensed" })
    })

    it("omits prose that carries no text, so an empty row is never landed", () => {
        expect(readCompactionSummary({ summary: "condensed", assistantText: "   " })).toEqual({ summary: "condensed" })
    })

    it("lands nothing when the summary is blank, because an empty summary would erase the conversation", () => {
        expect(readCompactionSummary({ summary: "  " })).toBeUndefined()
    })

    it("lands nothing for a result that is not a summary at all", () => {
        expect(readCompactionSummary(undefined)).toBeUndefined()
        expect(readCompactionSummary("condensed")).toBeUndefined()
        expect(readCompactionSummary({ messages: 3 })).toBeUndefined()
    })
})
