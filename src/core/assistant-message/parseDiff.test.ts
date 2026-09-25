/**
 * Unit tests for parseDiff — the unified diff parser producing ParsedBlock[].
 * Covers: single block, multi block, error blocks, streaming vs final error suppression.
 */

import { expect } from "chai"
import { describe, it } from "vitest"
import type { DiffResult } from "./diff"
import { DiffParser } from "./diff"

function runDiff(diffContent: string, originalContent: string, isPartial = false): DiffResult {
	const parser = new DiffParser(originalContent, isPartial)
	for (const line of diffContent.split("\n")) {
		parser.processLine(line)
	}
	parser.finalize()
	return parser.getResult()
}

describe("parseDiff", () => {
	const originalContent = "line1\nline2\nline3\n"

	it("should parse single block with correct match", async () => {
		const diff = ["------- SEARCH", "line2", "=======", "new line2", "+++++++ REPLACE"].join("\n")

		const result = runDiff(diff, originalContent)

		expect(result.blocks).to.have.lengthOf(1)
		expect(result.blocks[0].hasError).to.be.false
		expect(result.blocks[0].startLine).to.equal(2)
		expect(result.blocks[0].searchText).to.equal("line2")
		expect(result.blocks[0].replaceText).to.equal("new line2")
		expect(result.blocks[0].rawText).to.include("------- SEARCH")
		expect(result.newContent).to.equal("line1\nnew line2\nline3\n")
	})

	it("should parse multi-block diff", async () => {
		const diff = [
			"------- SEARCH",
			"line1",
			"=======",
			"new line1",
			"+++++++ REPLACE",
			"------- SEARCH",
			"line3",
			"=======",
			"new line3",
			"+++++++ REPLACE",
		].join("\n")

		const result = runDiff(diff, originalContent)

		expect(result.blocks).to.have.lengthOf(2)
		expect(result.blocks[0].hasError).to.be.false
		expect(result.blocks[1].hasError).to.be.false
		expect(result.newContent).to.equal("new line1\nline2\nnew line3\n")
	})

	it("should mark SEARCH_NOT_FOUND as error block with rawText", async () => {
		const diff = ["------- SEARCH", "does not exist", "=======", "should not insert", "+++++++ REPLACE"].join("\n")

		const result = await runDiff(diff, originalContent)

		expect(result.blocks).to.have.lengthOf(1)
		expect(result.blocks[0].hasError).to.be.true
		expect(result.blocks[0].startLine).to.equal(0)
		expect(result.blocks[0].rawText).to.include("------- SEARCH")
		expect(result.blocks[0].rawText).to.include("does not exist")
		// newContent should be unchanged
		expect(result.newContent).to.equal(originalContent)
	})

	it("should suppress UNCLOSED error during streaming (isPartial=true)", async () => {
		const diff = [
			"------- SEARCH",
			"line2",
			// Missing ======= and +++++++ REPLACE — unclosed
		].join("\n")

		const result = runDiff(diff, originalContent, true)
		// During streaming, unclosed blocks should NOT produce errors
		expect(result.blocks.some((b) => b.hasError)).to.be.false
	})

	it("should report UNCLOSED error at final (isPartial=false)", async () => {
		const diff = ["------- SEARCH", "line2"].join("\n")

		const result = runDiff(diff, originalContent) // default isPartial=false
		expect(result.blocks.some((b) => b.hasError)).to.be.true
	})

	it("should handle empty diff gracefully", async () => {
		const result = runDiff("", originalContent)
		expect(result.blocks).to.be.empty
		expect(result.newContent).to.equal(originalContent)
	})
})

function block(search: string[], replace: string[], delimiter = 7): string {
	return [
		`${"-".repeat(delimiter)} SEARCH`,
		...search,
		"=".repeat(delimiter),
		...replace,
		`${"+".repeat(delimiter)} REPLACE`,
	].join("\n")
}

describe("DiffParser line matching", () => {
	const source = [
		"export function foo(a: string): number {",
		"  return a.length",
		"}",
		"export function fooBar(a: string): number {",
		"  return a.length + 1",
		"}",
		"",
	].join("\n")

	it("replaces whole lines matched by line prefixes and reports the replaced range", () => {
		const result = runDiff(
			block(["export function foo(", "return a.length"], ["export function foo(a: string): number {", "  return 0"]),
			source,
		)
		const [only] = result.blocks
		expect(only.hasError).to.be.false
		expect(only.startLine).to.equal(1)
		expect(only.endLine).to.equal(2)
		expect(only.matchTier).to.equal("line_prefix")
		expect(only.matchedText).to.equal("export function foo(a: string): number {\n  return a.length")
		expect(result.newContent).to.equal(source.replace("  return a.length\n}", "  return 0\n}"))
	})

	it("rejects an ambiguous block with candidate line numbers and leaves the file untouched", () => {
		const result = runDiff(block(["export function foo"], ["x"]), source)
		const [only] = result.blocks
		expect(only.hasError).to.be.true
		expect(only.errorCode).to.equal("AMBIGUOUS_MATCH")
		expect(only.errorMessage).to.include("2 locations").and.include("lines 1, 4")
		expect(result.newContent).to.equal(source)
	})

	it("rejects a fragment starting in the middle of a line", () => {
		const result = runDiff(
			block(
				["return a.length + 1"].map((l) => l.slice(7)),
				["x"],
			),
			source,
		)
		expect(result.blocks[0].errorCode).to.equal("SEARCH_NOT_FOUND")
		expect(result.newContent).to.equal(source)
	})

	it("keeps a successful block when a later block is ambiguous", () => {
		const diff = [block(["export function fooBar("], ["export function baz(a: string): number {"]), block(["}"], [""])].join(
			"\n",
		)
		const result = runDiff(diff, source)
		expect(result.blocks[0].hasError).to.be.false
		expect(result.blocks[1].errorCode).to.equal("AMBIGUOUS_MATCH")
		expect(result.newContent).to.include("export function baz(a: string): number {")
	})

	it("reports out-of-order and overlapping blocks from their line ranges", () => {
		const outOfOrder = runDiff(
			[block(["export function fooBar("], ["A"]), block(["export function foo("], ["B"])].join("\n"),
			source,
		)
		expect(outOfOrder.blocks[1].errorCode).to.equal("BLOCK_OUT_OF_ORDER")

		const overlap = runDiff(
			[block(["export function foo(", "return a.length"], ["A"]), block(["return a.length", "}"], ["B"])].join("\n"),
			source,
		)
		expect(overlap.blocks[1].errorCode).to.equal("BLOCK_OVERLAP")
		expect(overlap.blocks[1].errorMessage).to.include("Block #2 overlaps with block #1")
		expect(overlap.newContent).to.equal(
			source.replace("export function foo(a: string): number {\n  return a.length\n", "A\n"),
		)
	})

	it("preserves CRLF line breaks and a missing final newline", () => {
		const crlf = "a\r\nb\r\nc"
		expect(runDiff(block(["b"], ["B1", "B2"]), crlf).newContent).to.equal("a\r\nB1\r\nB2\r\nc")
		expect(runDiff(block(["c"], ["C"]), crlf).newContent).to.equal("a\r\nb\r\nC")
	})
})

describe("DiffParser SKIP ranges", () => {
	const source = [
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

	it("deletes the whole range from head to nearest tail", () => {
		const result = runDiff(block(["export function legacy() {", "....... SKIP", "}"], []), source)
		const [only] = result.blocks
		expect(only.hasError).to.be.false
		expect(only.startLine).to.equal(2)
		expect(only.endLine).to.equal(7)
		expect(only.skippedLines).to.equal(4)
		expect(result.newContent).to.equal("const x = 1\n\nexport function keep() {\n}\n")
	})

	it("uses the block delimiter length for the SKIP marker", () => {
		const result = runDiff(block(["export function legacy() {", "......... SKIP", "}"], ["// removed"], 9), source)
		expect(result.blocks[0].hasError).to.be.false
		expect(result.newContent).to.include("// removed\n\nexport function keep()")
	})

	it("reports a missing tail with the head line", () => {
		const result = runDiff(block(["export function keep() {", "....... SKIP", "return 99"], []), source)
		expect(result.blocks[0].errorCode).to.equal("SEARCH_NOT_FOUND")
		expect(result.blocks[0].errorMessage).to.include("line 9")
		expect(result.newContent).to.equal(source)
	})

	for (const [name, search, replace] of [
		["as the first SEARCH line", ["....... SKIP", "}"], []],
		["as the last SEARCH line", ["export function legacy() {", "....... SKIP"], []],
		["twice in one block", ["const x", "....... SKIP", "  }", "....... SKIP", "}"], []],
		["inside REPLACE", ["const x = 1"], ["....... SKIP"]],
	] as const) {
		it(`rejects a SKIP marker ${name}, even while streaming`, () => {
			for (const isPartial of [false, true]) {
				const result = runDiff(block([...search], [...replace]), source, isPartial)
				expect(result.blocks[0].errorCode).to.equal("INVALID_SKIP_MARKER")
				expect(result.newContent).to.equal(source)
			}
		})
	}
})
