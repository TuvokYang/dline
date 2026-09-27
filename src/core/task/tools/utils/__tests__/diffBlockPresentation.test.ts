import { DiffParser, type ParsedBlock } from "@core/assistant-message/diff"
import { describe, expect, it } from "vitest"
import {
	briefDiffError,
	countAppliedLines,
	describeBlockOutcomes,
	describeFailureReminder,
	projectFinalCard,
	projectMissingFileCard,
	projectStreamingCard,
} from "../diffBlockPresentation"

const SOURCE = [
	"export function alpha(value: number): number {",
	"  const doubled = value * 2",
	"  const tripled = value * 3",
	"  const quadrupled = value * 4",
	"  return doubled + tripled + quadrupled",
	"}",
	"",
	"export function beta(): string {",
	"  return 'beta'",
	"}",
].join("\n")

function block(search: string[], replace: string[]): string {
	return ["------- SEARCH", ...search, "=======", ...replace, "+++++++ REPLACE"].join("\n")
}

function parse(diff: string, original = SOURCE, isPartial = false): ParsedBlock[] {
	const parser = new DiffParser(original, isPartial)
	for (const line of diff.split("\n")) {
		parser.processLine(line)
	}
	parser.finalize()
	return parser.getResult().blocks
}

describe("diffBlockPresentation", () => {
	it("projects the matched file lines, not the abbreviated SEARCH prefix", () => {
		const blocks = parse(
			block(["export function beta", "  return"], ["export function beta(): string {", "  return 'gamma'"]),
		)

		const card = projectFinalCard(blocks)

		expect(card.content).toEqual([
			"- export function beta(): string {\n-   return 'beta'\n+ export function beta(): string {\n+   return 'gamma'",
		])
		expect(card.startLineNumbers).toEqual([8])
		expect(card.blockErrors).toEqual([undefined])
	})

	it("shows every line of a SKIP range as removed", () => {
		const blocks = parse(block(["  const doubled", "....... SKIP", "  return doubled"], ["  return value * 9"]))

		const card = projectFinalCard(blocks)

		expect(card.content[0]).toBe(
			[
				"-   const doubled = value * 2",
				"-   const tripled = value * 3",
				"-   const quadrupled = value * 4",
				"-   return doubled + tripled + quadrupled",
				"+   return value * 9",
			].join("\n"),
		)
	})

	it("reports the replaced original range and the SKIP line count to the model", () => {
		const blocks = parse(block(["  const doubled", "....... SKIP", "  return doubled"], ["  return value * 9"]))

		expect(describeBlockOutcomes(blocks)).toBe(
			"success — replaced original lines 2-5, including 2 lines inside the SKIP range (deleted 4 lines, added 1 line).",
		)
		expect(countAppliedLines(blocks)).toEqual({ deletedLines: 4, addedLines: 1 })
	})

	it("numbers mixed outcomes and excludes failed blocks from the line totals", () => {
		const diff = [block(["  const doubled"], ["  const doubled = value + value"]), block(["  return"], ["  return 0"])].join(
			"\n",
		)
		const blocks = parse(diff)

		const outcomes = describeBlockOutcomes(blocks).split("\n")

		expect(outcomes[0]).toBe("Block #1: success — replaced original lines 2-2 (deleted 1 line, added 1 line).")
		expect(outcomes[1]).toMatch(/^Block #2: error — SEARCH content matches 2 locations/)
		expect(countAppliedLines(blocks)).toEqual({ deletedLines: 1, addedLines: 1 })
	})

	it("labels ambiguous and SKIP syntax failures on the card", () => {
		const ambiguous = projectFinalCard(parse(block(["  return"], ["  return 0"])))
		const invalidSkip = projectFinalCard(parse(block(["....... SKIP", "  return doubled"], ["  return 0"])))

		expect(ambiguous.blockErrors).toEqual(["SEARCH matches multiple locations"])
		expect(invalidSkip.blockErrors).toEqual(["Invalid SKIP marker"])
		expect(briefDiffError(undefined)).toBe("SEARCH/REPLACE error")
		expect(briefDiffError("UNKNOWN_CODE")).toBe("SEARCH/REPLACE error")
	})

	it("treats an invalid SKIP marker as conclusive while streaming", () => {
		const card = projectStreamingCard(parse(block(["....... SKIP"], []).split("\n").slice(0, 2).join("\n"), SOURCE, true))

		expect(card.blockErrors).toEqual(["Invalid SKIP marker"])
		expect(card.content[0]).toContain("....... SKIP")
	})

	it("does not report a match failure while the diff is still streaming", () => {
		const card = projectStreamingCard(parse(block(["  return"], ["  return 0"]), SOURCE, true))

		expect(card.blockErrors).toEqual([undefined])
		expect(card.content[0].startsWith("- ")).toBe(true)
	})

	it("labels an empty SEARCH block on the card", () => {
		expect(projectFinalCard(parse(block([], ["x"]))).blockErrors).toEqual(["Empty SEARCH block"])
	})

	it("shows every block of a refused missing-file edit with its raw text", () => {
		const card = projectMissingFileCard(parse(block(["  const doubled"], ["x"]), ""))

		expect(card.blockErrors).toEqual(["File not found"])
		expect(card.content[0]).toContain("------- SEARCH")
	})
})

describe("describeFailureReminder", () => {
	it("returns nothing when every block succeeded", () => {
		expect(describeFailureReminder(parse(block(["  const doubled"], ["x"])))).toBe("")
	})

	it("gives format advice without matching advice for a malformed block", () => {
		const reminder = describeFailureReminder(parse(block([], ["x"])))

		expect(reminder).toContain("<reminder>")
		expect(reminder).toContain("A SEARCH/REPLACE block is malformed")
		expect(reminder).toContain("A longer N is the fix")
		expect(reminder).not.toContain("did not identify exactly one location")
		expect(reminder).not.toMatch(/Do NOT add extra characters/i)
	})

	it("gives matching advice without format advice when SEARCH is not found", () => {
		const reminder = describeFailureReminder(parse(block(["  const missing"], ["x"])))

		expect(reminder).toContain("did not identify exactly one location")
		expect(reminder).not.toContain("A SEARCH/REPLACE block is malformed")
	})

	it("gives ordering advice for out-of-order blocks and tells the model which blocks already landed", () => {
		const blocks = parse([block(["export function beta"], ["A"]), block(["export function alpha"], ["B"])].join("\n"))
		const reminder = describeFailureReminder(blocks)

		expect(blocks[1].errorCode).toBe("BLOCK_OUT_OF_ORDER")
		expect(reminder).toContain("must follow file order")
		expect(reminder).toContain("resend only the failed blocks")
	})

	it("omits the partial-success note when no block was applied", () => {
		expect(describeFailureReminder(parse(block(["  const missing"], ["x"])))).not.toContain("resend only the failed blocks")
	})
})
