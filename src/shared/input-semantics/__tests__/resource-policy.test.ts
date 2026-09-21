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

	it("stores a paste that crosses the line budget", () => {
		const text = Array.from({ length: INLINE_TEXT_MAX_LINES + 1 }, (_, index) => `line ${index}`).join("\n")

		expect(countTextLines(text)).toBe(INLINE_TEXT_MAX_LINES + 1)
		expect(exceedsInlineTextBudget(text)).toBe(true)
	})

	it("keeps a paste exactly at the line budget inline", () => {
		const text = Array.from({ length: INLINE_TEXT_MAX_LINES }, (_, index) => `line ${index}`).join("\n")

		expect(exceedsInlineTextBudget(text)).toBe(false)
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
