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

	for (const [name, search, replace, violatedRule] of [
		["as the first SEARCH line", ["....... SKIP", "}"], [], "is the first SEARCH line"],
		["as the last SEARCH line", ["export function legacy() {", "....... SKIP"], [], "is the last SEARCH line"],
		["twice in one block", ["const x", "....... SKIP", "  }", "....... SKIP", "}"], [], "second SKIP marker"],
		["inside REPLACE", ["const x = 1"], ["....... SKIP"], "REPLACE section contains the SKIP marker"],
	] as const) {
		it(`rejects a SKIP marker ${name} and names the violated rule, even while streaming`, () => {
			for (const isPartial of [false, true]) {
				const result = runDiff(block([...search], [...replace]), source, isPartial)
				expect(result.blocks[0].errorCode).to.equal("INVALID_SKIP_MARKER")
				expect(result.blocks[0].errorMessage).to.include(violatedRule)
				expect(result.newContent).to.equal(source)
			}
		})
	}

	it("explains a SKIP line whose dot count does not match the delimiter", () => {
		const result = runDiff(block(["export function legacy() {", "......... SKIP", "}"], []), source)
		const [only] = result.blocks
		expect(only.errorCode).to.equal("SEARCH_NOT_FOUND")
		expect(only.errorMessage).to.include('SEARCH line 2 "......... SKIP"').and.include('"....... SKIP"')
		expect(result.newContent).to.equal(source)
	})
})

describe("DiffParser failure diagnostics", () => {
	const source = ["const a = 1", "const b = 2", "const c = 3", ""].join("\n")

	function parseOne(diff: string, original = source) {
		const result = runDiff(diff, original)
		expect(result.blocks).to.have.lengthOf(1)
		return { failed: result.blocks[0], newContent: result.newContent }
	}

	it("points at a separator line that carries extra text", () => {
		const { failed, newContent } = parseOne(
			["------- SEARCH", "const a = 1", "======= REPLACE", "const a = 10", "+++++++ REPLACE"].join("\n"),
		)
		expect(failed.errorCode).to.equal("MISSING_SEPARATOR")
		expect(failed.errorMessage).to.include('SEARCH line 2 "======= REPLACE"').and.include("only equals signs")
		expect(newContent).to.equal(source)
	})

	it("reports a separator shorter than the SEARCH marker as a delimiter mismatch", () => {
		const { failed } = parseOne(
			["--------- SEARCH", "const a = 1", "=======", "const a = 10", "+++++++++ REPLACE"].join("\n"),
		)
		expect(failed.errorCode).to.equal("DELIMITER_MISMATCH")
		expect(failed.errorMessage)
			.to.include("9-character SEARCH marker")
			.and.include('SEARCH line 2 "=======" uses 7 characters')
	})

	it("reports the mismatched separator even when the block never closes", () => {
		const { failed } = parseOne(["--------- SEARCH", "const a = 1", "=======", "const a = 10", "+++++++ REPLACE"].join("\n"))
		expect(failed.errorCode).to.equal("DELIMITER_MISMATCH")
		expect(failed.errorMessage).to.include('SEARCH line 2 "=======" uses 7 characters')
	})

	it("reports a closing marker longer than the SEARCH marker", () => {
		const { failed } = parseOne(["------- SEARCH", "const a = 1", "=======", "const a = 10", "+++++++++ REPLACE"].join("\n"))
		expect(failed.errorCode).to.equal("DELIMITER_MISMATCH")
		expect(failed.errorMessage).to.include('REPLACE line 2 "+++++++++ REPLACE" uses 9 characters')
	})

	it("names read_file line labels when every SEARCH line carries one", () => {
		const { failed } = parseOne(block(["1 | const a = 1", "2 | const b = 2"], ["const a = 10"]))
		expect(failed.errorCode).to.equal("SEARCH_NOT_FOUND")
		expect(failed.errorMessage).to.include("read_file line label").and.include('"1 | "')
	})

	it("shows where non-consecutive SEARCH lines stop matching", () => {
		const { failed } = parseOne(block(["const a = 1", "const c = 3"], ["x"]))
		expect(failed.errorCode).to.equal("SEARCH_NOT_FOUND")
		expect(failed.errorMessage).to.include('SEARCH line 2 "const c = 3" differs from file line 2 "const b = 2"')
	})

	it("reports a first SEARCH line that begins no file line", () => {
		const { failed } = parseOne(block(["const z = 9", "const a = 1"], ["x"]))
		expect(failed.errorMessage).to.include('SEARCH line 1 "const z = 9" is not the beginning of any file line')
	})

	it("uses singular wording for a one-line SEARCH", () => {
		const { failed } = parseOne(block(["const z = 9"], ["x"]))
		expect(failed.errorMessage).to.include("SEARCH content (1 line) was not found")
	})

	it("rejects an empty SEARCH section without blaming the delimiters", () => {
		for (const original of [source, ""]) {
			const { failed, newContent } = parseOne(block([], ["const a = 10"]), original)
			expect(failed.errorCode).to.equal("EMPTY_SEARCH")
			expect(failed.errorMessage).to.include("SEARCH section is empty").and.not.include("delimiter")
			expect(newContent).to.equal(original)
		}
	})

	it("suggests a complete longer marker set when a content line equals the separator", () => {
		const { failed } = parseOne(["------- SEARCH", "=======", "const a = 1", "=======", "x", "+++++++ REPLACE"].join("\n"))
		expect(failed.errorCode).to.equal("DELIMITER_CONFLICT")
		expect(failed.errorMessage).to.include("-------- SEARCH").and.include("++++++++ REPLACE")
	})

	it("keeps accepting a separator-like content line inside 8-character markers", () => {
		const original = ["title", "=======", "body", ""].join("\n")
		const result = runDiff(block(["title", "=======", "body"], ["title", "=======", "new body"], 8), original)
		expect(result.blocks[0].hasError).to.be.false
		expect(result.newContent).to.equal("title\n=======\nnew body\n")
	})

	it("keeps accepting a 7-dot SKIP-like content line inside 8-character markers", () => {
		const original = ["start", "....... SKIP", "end", ""].join("\n")
		const result = runDiff(block(["start", "....... SKIP", "end"], ["start", "end"], 8), original)
		expect(result.blocks[0].hasError).to.be.false
		expect(result.blocks[0].skippedLines).to.equal(0)
		expect(result.newContent).to.equal("start\nend\n")
	})
})
