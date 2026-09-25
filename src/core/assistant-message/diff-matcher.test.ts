import { describe, expect, it } from "vitest"
import { FileLineIndex, matchSearchBlock, type SearchMatch } from "./diff-matcher"

function match(content: string, head: string[], tail?: string[]): SearchMatch {
	return matchSearchBlock(new FileLineIndex(content), tail ? { head, tail } : { head })
}

function expectUnique(result: SearchMatch) {
	if (result.kind !== "unique") {
		throw new Error(`expected a unique match, got ${JSON.stringify(result)}`)
	}
	return result
}

const TWO_FUNCTIONS = [
	"export function foo(a: string): number {",
	"  return a.length",
	"}",
	"export function fooBar(a: string): number {",
	"  return a.length + 1",
	"}",
	"",
].join("\n")

describe("matchSearchBlock", () => {
	describe("exact tier", () => {
		it("matches a unique whole line and reports line-aligned offsets", () => {
			const result = expectUnique(match("a\nb\nc\n", ["b"]))
			expect(result.tier).toBe("exact")
			expect(result.range).toEqual({ startLine: 2, endLine: 2, startIndex: 2, endIndex: 4 })
			expect(result.skippedLines).toBe(0)
		})

		it("reports every candidate line when the block matches more than once", () => {
			expect(match("a\nb\nc\nb\n", ["b"])).toEqual({ kind: "ambiguous", tier: "exact", candidateLines: [2, 4] })
		})

		it("prefers the stricter tier when it is unique even if looser tiers match more", () => {
			const result = expectUnique(match("foo\nfoo bar\n", ["foo"]))
			expect(result.tier).toBe("exact")
			expect(result.range.startLine).toBe(1)
		})
	})

	describe("line_trim tier", () => {
		it("tolerates leading and trailing whitespace differences", () => {
			const result = expectUnique(match("  foo()\nbar\n", ["foo()  "]))
			expect(result.tier).toBe("line_trim")
			expect(result.range).toEqual({ startLine: 1, endLine: 1, startIndex: 0, endIndex: 8 })
		})

		it("reports ambiguity instead of falling through to the prefix tier", () => {
			expect(match("  x = 1\n\tx = 1\nx = 10\n", ["x = 1"])).toEqual({
				kind: "ambiguous",
				tier: "line_trim",
				candidateLines: [1, 2],
			})
		})
	})

	describe("line_prefix tier", () => {
		it("matches consecutive line beginnings with omitted indentation", () => {
			const result = expectUnique(match(TWO_FUNCTIONS, ["export function foo(", "return a.length"]))
			expect(result.tier).toBe("line_prefix")
			expect(result.range.startLine).toBe(1)
			expect(result.range.endLine).toBe(2)
		})

		it("reports ambiguity when a prefix starts several lines", () => {
			expect(match(TWO_FUNCTIONS, ["export function foo"])).toEqual({
				kind: "ambiguous",
				tier: "line_prefix",
				candidateLines: [1, 4],
			})
		})

		it("never matches a fragment that starts in the middle of a line", () => {
			expect(match(TWO_FUNCTIONS, ["function foo("])).toEqual({ kind: "not_found", part: "block" })
		})

		it("never matches a trailing fragment of a line", () => {
			expect(match("const timeout = 30_000\n", ["30_000"])).toEqual({ kind: "not_found", part: "block" })
		})

		it("lets a blank SEARCH line match only a blank file line", () => {
			expect(match("a\nx\nb\n", ["a", "", "b"])).toEqual({ kind: "not_found", part: "block" })
			expect(expectUnique(match("a\n\nb\n", ["a", "", "b"])).range.endLine).toBe(3)
		})
	})

	describe("line endings", () => {
		it("treats CRLF as the line terminator and includes it in the range", () => {
			const result = expectUnique(match("a\r\nb\r\nc\r\n", ["b"]))
			expect(result.tier).toBe("exact")
			expect(result.range).toEqual({ startLine: 2, endLine: 2, startIndex: 3, endIndex: 6 })
		})

		it("ends the range at EOF when the last line has no terminator", () => {
			const result = expectUnique(match("a\nb", ["b"]))
			expect(result.range).toEqual({ startLine: 2, endLine: 2, startIndex: 2, endIndex: 3 })
		})

		it("does not treat the phantom line after a trailing newline as matchable", () => {
			expect(match("a\n", ["a", ""])).toEqual({ kind: "not_found", part: "block" })
		})
	})

	describe("SKIP ranges", () => {
		const LEGACY = [
			"const x = 1",
			"export function legacy() {",
			"  if (a) {",
			"    return 1",
			"  }",
			"  return 2",
			"}",
			"",
			"export function keep() {",
			"}",
			"",
		].join("\n")

		it("spans from the unique head to the nearest exact tail and counts skipped lines", () => {
			const result = expectUnique(match(LEGACY, ["export function legacy() {"], ["}"]))
			expect(result.range.startLine).toBe(2)
			expect(result.range.endLine).toBe(7)
			expect(result.skippedLines).toBe(4)
			expect(LEGACY.slice(result.range.startIndex, result.range.endIndex)).toBe(
				"export function legacy() {\n  if (a) {\n    return 1\n  }\n  return 2\n}\n",
			)
		})

		it("falls back to a whitespace-tolerant tail when no exact tail follows the head", () => {
			const content = "fn() {\n  body\n  }\nnext\n"
			const result = expectUnique(match(content, ["fn() {"], ["}"]))
			expect(result.range.endLine).toBe(3)
			expect(result.skippedLines).toBe(1)
		})

		it("rejects an ambiguous head with its candidate lines", () => {
			expect(match(LEGACY, ["export function"], ["}"])).toEqual({
				kind: "ambiguous",
				tier: "line_prefix",
				candidateLines: [2, 9],
			})
		})

		it("reports a missing tail together with the head line", () => {
			expect(match(LEGACY, ["export function keep() {"], ["return 99"])).toEqual({
				kind: "not_found",
				part: "skip_tail",
				headLine: 9,
			})
		})

		it("only searches for the tail after the head", () => {
			const content = "end\nstart\nmiddle\n"
			expect(match(content, ["start"], ["end"])).toEqual({ kind: "not_found", part: "skip_tail", headLine: 2 })
		})

		it("supports multi-line heads and tails", () => {
			const result = expectUnique(match(LEGACY, ["const x", "export function legacy"], ["  return 2", "}"]))
			expect(result.range.startLine).toBe(1)
			expect(result.range.endLine).toBe(7)
			expect(result.skippedLines).toBe(3)
		})
	})

	it("returns not_found for an empty file", () => {
		expect(match("", ["a"])).toEqual({ kind: "not_found", part: "block" })
	})
})
