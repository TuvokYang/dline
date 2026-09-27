/**
 * Failure diagnostics for replace_in_file SEARCH/REPLACE blocks.
 *
 * Every function here explains a block that has already failed. A block may use
 * longer markers precisely so that marker-like text can appear as content, so a
 * marker-like content line is never an error by itself; it only explains why a
 * failed block was read the way it was. Nothing here changes which blocks are
 * accepted.
 */

import { renderPrompt } from "@core/prompts/i18n"
import { type FileLineIndex, findLongestLeadingMatch } from "./diff-matcher"

/** Section of a SEARCH/REPLACE block that a diagnosed line belongs to. */
export type BlockSection = "SEARCH" | "REPLACE"

/** Marker-like content line that explains a structural failure. */
export type MarkerProblem =
	| { kind: "separator_with_text"; section: BlockSection; lineNumber: number; text: string }
	| { kind: "count_mismatch"; section: BlockSection; lineNumber: number; text: string; count: number }

type MarkerProblemKind = { kind: "separator_with_text" } | { kind: "count_mismatch"; count: number }

const SKIP_MARKER_SUFFIX = " SKIP"
const MAX_QUOTED_LENGTH = 80

const SEPARATOR_LIKE = /^(={7,})(.*)$/
const CLOSE_MARKER_LIKE = /^(\++) REPLACE>?$/
const SKIP_MARKER_LIKE = /^(\.+) SKIP$/
/** read_file line label such as "42 | ", or "42 |" on a blank line. */
const READ_FILE_LINE_LABEL = /^\s*\d+ \|(?: |$)/

/** Formats a line count with the grammatical number of "line". */
export function formatLineCount(count: number): string {
	return `${count} ${count === 1 ? "line" : "lines"}`
}

/** SKIP marker of one block: as many dots as the block delimiter, then " SKIP". */
export function skipMarkerFor(delimiterCount: number): string {
	return `${".".repeat(delimiterCount)}${SKIP_MARKER_SUFFIX}`
}

/**
 * Finds the first content line that looks like a marker of this block but was
 * not recognized as one.
 *
 * SEARCH lines are checked for a separator carrying extra text and for
 * separator or close markers of another length. REPLACE lines are checked only
 * for close markers of another length, because a separator-like line there is
 * ordinary content or already reported as a delimiter conflict.
 *
 * @param lines Content lines of the section, as written.
 * @param section Section the lines belong to.
 * @param delimiterCount Marker length the block opened with.
 */
export function findMarkerProblem(
	lines: readonly string[],
	section: BlockSection,
	delimiterCount: number,
): MarkerProblem | undefined {
	for (const [index, line] of lines.entries()) {
		const text = line.trim()
		const problem = classifyMarkerLine(text, section, delimiterCount)
		if (problem) {
			return { ...problem, section, lineNumber: index + 1, text }
		}
	}
	return undefined
}

/** Renders the message that replaces a generic structural error. */
export function describeMarkerProblem(problem: MarkerProblem, delimiterCount: number): string {
	if (problem.kind === "separator_with_text") {
		return renderPrompt("replaceInFile", "diffSeparatorWithText", {
			LINE: String(problem.lineNumber),
			TEXT: quote(problem.text),
			COUNT: String(delimiterCount),
		})
	}
	return renderPrompt("replaceInFile", "diffMarkerCountMismatch", {
		OPEN_COUNT: String(delimiterCount),
		SECTION: problem.section,
		LINE: String(problem.lineNumber),
		TEXT: quote(problem.text),
		COUNT: String(problem.count),
	})
}

/**
 * Explains why SEARCH lines were not found.
 *
 * read_file line labels explain every line at once, so they suppress the other
 * findings. Otherwise a SKIP line with the wrong dot count and the point where
 * consecutive matching stops are both reported.
 *
 * @param index Line index of the original file.
 * @param searchLines Every SEARCH line of the block.
 * @param headLines SEARCH lines that had to match as one consecutive run.
 * @param delimiterCount Marker length the block opened with.
 * @returns Findings in reporting order; empty when nothing specific is known.
 */
export function explainSearchNotFound(
	index: FileLineIndex,
	searchLines: readonly string[],
	headLines: readonly string[],
	delimiterCount: number,
): string[] {
	const label = findReadFileLineLabel(searchLines, delimiterCount)
	if (label) {
		return [renderPrompt("replaceInFile", "diffHintLineLabels", { LABEL: label })]
	}
	const findings: string[] = []
	const skipFinding = describeMiscountedSkipLine(searchLines, delimiterCount)
	if (skipFinding) findings.push(skipFinding)
	const breakPoint = describeBreakPoint(index, headLines)
	if (breakPoint) findings.push(breakPoint)
	return findings
}

/** Appends findings to a failure message under a common header. */
export function withFindings(message: string, findings: readonly string[]): string {
	if (findings.length === 0) return message
	const listed = findings.map((finding) => `- ${finding}`).join("\n")
	return `${message}\n\n${renderPrompt("replaceInFile", "diffFindingsHeader")}\n${listed}`
}

function classifyMarkerLine(text: string, section: BlockSection, delimiterCount: number): MarkerProblemKind | undefined {
	const closeMarker = CLOSE_MARKER_LIKE.exec(text)
	if (closeMarker) {
		const count = closeMarker[1].length
		return count === delimiterCount ? undefined : { kind: "count_mismatch", count }
	}
	if (section !== "SEARCH") return undefined
	const separator = SEPARATOR_LIKE.exec(text)
	if (!separator) return undefined
	if (separator[2].trim() !== "") return { kind: "separator_with_text" }
	const count = separator[1].length
	return count === delimiterCount ? undefined : { kind: "count_mismatch", count }
}

/**
 * Returns the first label when every written SEARCH line carries one. Blank
 * lines and the block's SKIP marker never carry a label, so they are ignored.
 */
function findReadFileLineLabel(searchLines: readonly string[], delimiterCount: number): string | undefined {
	const skipMarker = skipMarkerFor(delimiterCount)
	const written = searchLines.filter((line) => line.trim() !== "" && line.trim() !== skipMarker)
	if (written.length === 0) return undefined
	const labels = written.map((line) => READ_FILE_LINE_LABEL.exec(line))
	if (labels.some((label) => label === null)) return undefined
	return labels[0]?.[0].trimStart()
}

function describeMiscountedSkipLine(searchLines: readonly string[], delimiterCount: number): string | undefined {
	for (const [index, line] of searchLines.entries()) {
		const text = line.trim()
		const skipLike = SKIP_MARKER_LIKE.exec(text)
		if (skipLike && skipLike[1].length !== delimiterCount) {
			return renderPrompt("replaceInFile", "diffHintSkipDotCount", {
				LINE: String(index + 1),
				TEXT: quote(text),
				SKIP_MARKER: skipMarkerFor(delimiterCount),
			})
		}
	}
	return undefined
}

function describeBreakPoint(index: FileLineIndex, headLines: readonly string[]): string | undefined {
	if (headLines.length === 0) return undefined
	if (index.lines.length === 0) {
		return renderPrompt("replaceInFile", "diffHintEmptyFile")
	}
	const leading = findLongestLeadingMatch(index, headLines)
	if (!leading) {
		return renderPrompt("replaceInFile", "diffHintFirstLineMissing", { TEXT: quote(headLines[0]) })
	}
	if (leading.matchedLines >= headLines.length) return undefined

	const searchLine = leading.matchedLines + 1
	const fileLine = leading.startLine + leading.matchedLines
	const text = quote(headLines[leading.matchedLines])
	if (fileLine > index.lines.length) {
		return renderPrompt("replaceInFile", "diffHintFileEnds", {
			LINE: String(searchLine),
			TEXT: text,
			FROM: String(leading.startLine),
		})
	}
	return renderPrompt("replaceInFile", "diffHintBreakPoint", {
		LINE: String(searchLine),
		TEXT: text,
		FILE_LINE: String(fileLine),
		FILE_TEXT: quote(index.lines[fileLine - 1].text),
		FROM: String(leading.startLine),
	})
}

/** Trims a line for quoting inside a message and bounds its length. */
function quote(text: string): string {
	const trimmed = text.trim()
	return trimmed.length > MAX_QUOTED_LENGTH ? `${trimmed.slice(0, MAX_QUOTED_LENGTH - 1)}…` : trimmed
}
