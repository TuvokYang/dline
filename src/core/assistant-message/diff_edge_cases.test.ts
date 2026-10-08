import { expect } from "chai"
import { describe, it } from "vitest"
import { DIFF_ERROR_CODE, type DiffErrorCode, DiffParser } from "./diff"

/** Parse diff text through the production DiffParser path. */
function parseWithDiffParser(diffContent: string, originalContent: string): ReturnType<DiffParser["getResult"]> {
	const parser = new DiffParser(originalContent)
	for (const line of diffContent.split("\n")) {
		parser.processLine(line)
	}
	parser.finalize()
	return parser.getResult()
}

/** Assert that the production DiffParser returns an error block with the expected code. */
function expectParserError(diffContent: string, originalContent: string, code: DiffErrorCode): void {
	const result = parseWithDiffParser(diffContent, originalContent)
	const errorBlock = result.blocks.find((block) => block.hasError)
	expect(errorBlock?.errorCode).to.equal(code)
}

/** Assert that the production DiffParser rejects the diff with some block error. */
function expectParserRejects(diffContent: string, originalContent: string): void {
	const result = parseWithDiffParser(diffContent, originalContent)
	expect(result.blocks.some((block) => block.hasError)).to.equal(true)
}

describe("Diff Format Edge Cases", () => {
	it("should reject SEARCH with less than 7 delimiters at block start", () => {
		const original = "before\ncontent\nafter"
		const diff = `----- SEARCH
content
=======
new content
+++++++ REPLACE`
		expectParserError(diff, original, DIFF_ERROR_CODE.DELIMITER_TOO_SHORT)
	})

	it("should reject SEARCH with more than 7 and mismatched REPLACE delimiter", () => {
		const original = "before\ncontent\nafter"
		const diff = `----------- SEARCH
content
=======
new content
+++++++ REPLACE`
		expectParserRejects(diff, original)
	})

	it("should reject SEARCH <7 and REPLACE <7", () => {
		const original = "before\ncontent\nafter"
		const diff = `----- SEARCH
content
=====
new content
+++++++ REPLACE`
		expectParserError(diff, original, DIFF_ERROR_CODE.DELIMITER_TOO_SHORT)
	})

	it("should reject SEARCH <7 and REPLACE >7", () => {
		const original = "before\ncontent\nafter"
		const diff = `----- SEARCH
content
========
new content
+++++++ REPLACE`
		expectParserError(diff, original, DIFF_ERROR_CODE.DELIMITER_TOO_SHORT)
	})

	it("should reject SEARCH >7 with mismatched REPLACE delimiter", () => {
		const original = "before\ncontent\nafter"
		const diff = `----------- SEARCH
content
==========
new content
+++++++ REPLACE`
		expectParserRejects(diff, original)
	})

	it("should reject SEARCH >7 with less REPLACE delimiters", () => {
		const original = "before\ncontent\nafter"
		const diff = `----------- SEARCH
content
=====
new content
+++++++ REPLACE`
		expectParserRejects(diff, original)
	})

	it("should reject second block when second SEARCH has less than 7", () => {
		const original = "before\nfirst content\nafter\nsecond content\nend"
		const diff = `------- SEARCH
first content
=======
first new content
+++++++ REPLACE
----- SEARCH
second content
=======
second new content
+++++++ REPLACE`
		const parserResult = parseWithDiffParser(diff, original)
		expect(parserResult.newContent).to.equal("before\nfirst new content\nafter\nsecond content\nend")
		expect(parserResult.blocks[1]?.errorCode).to.equal(DIFF_ERROR_CODE.DELIMITER_TOO_SHORT)
	})

	it("should reject second block when second SEARCH and REPLACE both <7", () => {
		const original = "before\nfirst content\nafter\nsecond content\nend"
		const diff = `------- SEARCH
first content
=======
first new content
+++++++ REPLACE
----- SEARCH
second content
=====
second new content
+++++++ REPLACE`
		const parserResult = parseWithDiffParser(diff, original)
		expect(parserResult.newContent).to.equal("before\nfirst new content\nafter\nsecond content\nend")
		expect(parserResult.blocks[1]?.errorCode).to.equal(DIFF_ERROR_CODE.DELIMITER_TOO_SHORT)
	})

	it("should treat short SEARCH marker inside content as normal text", () => {
		const original = "before\nalpha\n----- SEARCH\nomega\nafter"
		const diff = `------- SEARCH
alpha
----- SEARCH
omega
=======
alpha
----- SEARCH
changed
+++++++ REPLACE`
		const parserResult = parseWithDiffParser(diff, original)
		expect(parserResult.newContent).to.equal("before\nalpha\n----- SEARCH\nchanged\nafter")
		expect(parserResult.blocks.some((block) => block.errorCode === DIFF_ERROR_CODE.DELIMITER_TOO_SHORT)).to.equal(false)
	})
})
