import { describe, expect, it } from "vitest"
import {
    countTextLines,
    countUtf8Bytes,
    exceedsInlineTextBudget,
    INLINE_TEXT_MAX_BYTES,
    INLINE_TEXT_MAX_LINES,
} from "../resource-policy"

describe("inline input text budget", () => {
    it("keeps a short paste inline", () => {
        expect(exceedsInlineTextBudget("one\ntwo\nthree")).toBe(false)
    })

    // WS-041 AC-11 sets the threshold as ">=20 logical lines or >=5000 UTF-8
    // bytes". An earlier version of this suite asserted that exactly 20 lines
    // stayed inline, which encoded the opposite of the specification.
    const lines = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join("\n")

    it("stores a paste that reaches the line budget", () => {
        expect(countTextLines(lines(INLINE_TEXT_MAX_LINES))).toBe(INLINE_TEXT_MAX_LINES)
        expect(exceedsInlineTextBudget(lines(INLINE_TEXT_MAX_LINES))).toBe(true)
    })

    it("keeps a paste one line under the budget inline", () => {
        expect(exceedsInlineTextBudget(lines(INLINE_TEXT_MAX_LINES - 1))).toBe(false)
    })

    it("counts CRLF and bare CR line breaks as logical lines", () => {
        const crlf = lines(INLINE_TEXT_MAX_LINES).replaceAll("\n", "\r\n")
        const cr = lines(INLINE_TEXT_MAX_LINES).replaceAll("\n", "\r")

        expect(countTextLines(crlf)).toBe(INLINE_TEXT_MAX_LINES)
        expect(countTextLines(cr)).toBe(INLINE_TEXT_MAX_LINES)
        expect(exceedsInlineTextBudget(cr)).toBe(true)
    })

    it("stores a paste that reaches the byte budget and keeps one byte under it inline", () => {
        expect(exceedsInlineTextBudget("a".repeat(INLINE_TEXT_MAX_BYTES))).toBe(true)
        expect(exceedsInlineTextBudget("a".repeat(INLINE_TEXT_MAX_BYTES - 1))).toBe(false)
    })

    it("measures the budget in UTF-8 bytes, not characters", () => {
        const multibyte = "字".repeat(INLINE_TEXT_MAX_BYTES / 2)

        expect(multibyte.length).toBeLessThan(INLINE_TEXT_MAX_BYTES)
        expect(countUtf8Bytes(multibyte)).toBeGreaterThan(INLINE_TEXT_MAX_BYTES)
        expect(exceedsInlineTextBudget(multibyte)).toBe(true)
    })

    it("reports no lines for empty text", () => {
        expect(countTextLines("")).toBe(0)
        expect(exceedsInlineTextBudget("")).toBe(false)
    })
})
