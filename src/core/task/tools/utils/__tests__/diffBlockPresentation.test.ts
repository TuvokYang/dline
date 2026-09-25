import { DiffParser, type ParsedBlock } from "@core/assistant-message/diff"
import { describe, expect, it } from "vitest"
import {
	briefDiffError,
	countAppliedLines,
	describeBlockOutcomes,
	projectFinalCard,
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
			"success — replaced original lines 2-5, including 2 lines inside the SKIP range (deleted 4 lines, added 1 lines).",
		)
		expect(countAppliedLines(blocks)).toEqual({ deletedLines: 4, addedLines: 1 })
	})

	it("numbers mixed outcomes and excludes failed blocks from the line totals", () => {
		const diff = [block(["  const doubled"], ["  const doubled = value + value"]), block(["  return"], ["  return 0"])].join(
			"\n",
		)
		const blocks = parse(diff)

		const outcomes = describeBlockOutcomes(blocks).split("\n")

		expect(outcomes[0]).toBe("Block #1: success — replaced original lines 2-2 (deleted 1 lines, added 1 lines).")
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
})
