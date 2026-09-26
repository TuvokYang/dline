/**
 * Line-aligned SEARCH matching for replace_in_file.
 *
 * Every SEARCH line is compared with one whole file line; matching never starts
 * in the middle of a line. Tiers are tried from strictest to loosest and the
 * first tier that yields any candidate decides the outcome, so a block is
 * applied only when it identifies exactly one location in the whole file.
 */

/** Matching strictness, ordered from strictest to loosest. */
export type MatchTier = "exact" | "line_trim" | "line_prefix"

export const MATCH_TIERS: readonly MatchTier[] = ["exact", "line_trim", "line_prefix"]

/** SEARCH lines of one block; `tail` is present only for SKIP ranges. */
export interface SearchPattern {
	head: readonly string[]
	tail?: readonly string[]
}

/** Matched region of the original file, always aligned to whole lines. */
export interface LineRange {
	/** 1-based, inclusive. */
	startLine: number
	/** 1-based, inclusive. */
	endLine: number
	/** Offset of the first matched line start. */
	startIndex: number
	/** Offset just after the last matched line terminator, or EOF. */
	endIndex: number
}

export type SearchMatch =
	| { kind: "unique"; tier: MatchTier; range: LineRange; skippedLines: number }
	| { kind: "ambiguous"; tier: MatchTier; candidateLines: number[] }
	| { kind: "not_found"; part: "block" }
	| { kind: "not_found"; part: "skip_tail"; headLine: number }

/** Longest run of leading SEARCH lines found on consecutive file lines. */
export interface LeadingMatch {
	/** 1-based file line where the run starts. */
	startLine: number
	/** Number of leading SEARCH lines in the run, at least 1. */
	matchedLines: number
}

interface IndexedLine {
	/** Line content without its terminator (`\n` or `\r\n`). */
	text: string
	trimmed: string
	trimmedStart: string
	start: number
	end: number
}

interface SearchLine {
	text: string
	trimmed: string
}

type LineMatcher = (fileLine: IndexedLine, searchLine: SearchLine) => boolean

const LINE_MATCHERS: Record<MatchTier, LineMatcher> = {
	exact: (fileLine, searchLine) => fileLine.text === searchLine.text,
	line_trim: (fileLine, searchLine) => fileLine.trimmed === searchLine.trimmed,
	// A blank SEARCH line would otherwise be a prefix of every line.
	line_prefix: (fileLine, searchLine) =>
		searchLine.trimmed === "" ? fileLine.trimmed === "" : fileLine.trimmedStart.startsWith(searchLine.trimmed),
}

/**
 * Splits the original file once so every block of one parse shares the same
 * line offsets. A trailing newline does not create an extra matchable line.
 */
export class FileLineIndex {
	readonly lines: readonly IndexedLine[]

	constructor(readonly content: string) {
		this.lines = indexLines(content)
	}

	rangeOf(startLineIndex: number, endLineIndex: number): LineRange {
		return {
			startLine: startLineIndex + 1,
			endLine: endLineIndex + 1,
			startIndex: this.lines[startLineIndex].start,
			endIndex: this.lines[endLineIndex].end,
		}
	}

	slice(range: LineRange): string {
		return this.content.slice(range.startIndex, range.endIndex)
	}

	/** Matched lines joined with "\n", without line terminators. */
	lineText(range: LineRange): string {
		return this.lines
			.slice(range.startLine - 1, range.endLine)
			.map((line) => line.text)
			.join("\n")
	}
}

/**
 * Locates one SEARCH block in the original file.
 *
 * Without a tail, the head must match exactly one location. With a tail (SKIP
 * range), the head must be unique and the range ends at the nearest tail match
 * after it, preferring stricter tiers so the smallest plausible range wins.
 */
export function matchSearchBlock(index: FileLineIndex, pattern: SearchPattern): SearchMatch {
	const head = normalizeSearchLines(pattern.head)
	if (head.length === 0) {
		return { kind: "not_found", part: "block" }
	}

	const headLocation = locateUnique(index.lines, head)
	if (headLocation.kind === "not_found") {
		return { kind: "not_found", part: "block" }
	}
	if (headLocation.kind === "ambiguous") {
		return {
			kind: "ambiguous",
			tier: headLocation.tier,
			candidateLines: headLocation.starts.map((start) => start + 1),
		}
	}

	const headEnd = headLocation.start + head.length - 1
	if (pattern.tail === undefined) {
		return uniqueMatch(index, headLocation.tier, headLocation.start, headEnd, 0)
	}

	const tail = normalizeSearchLines(pattern.tail)
	const tailLocation = tail.length > 0 ? locateNearest(index.lines, tail, headEnd + 1) : undefined
	if (!tailLocation) {
		return { kind: "not_found", part: "skip_tail", headLine: headLocation.start + 1 }
	}

	const tailEnd = tailLocation.start + tail.length - 1
	const skippedLines = tailLocation.start - headEnd - 1
	return uniqueMatch(index, looserTier(headLocation.tier, tailLocation.tier), headLocation.start, tailEnd, skippedLines)
}

/**
 * Finds where the longest run of leading SEARCH lines matches consecutive file
 * lines under the loosest tier, preferring the earliest run on ties.
 *
 * Only a failed block is explained this way, so the O(file × SEARCH) scan never
 * runs on the success path.
 *
 * @returns undefined when the first SEARCH line does not begin any file line.
 */
export function findLongestLeadingMatch(index: FileLineIndex, lines: readonly string[]): LeadingMatch | undefined {
	const search = normalizeSearchLines(lines)
	const matcher = LINE_MATCHERS.line_prefix
	let best: LeadingMatch | undefined
	for (let start = 0; start < index.lines.length; start++) {
		let matched = 0
		while (
			matched < search.length &&
			start + matched < index.lines.length &&
			matcher(index.lines[start + matched], search[matched])
		) {
			matched++
		}
		if (matched > 0 && (!best || matched > best.matchedLines)) {
			best = { startLine: start + 1, matchedLines: matched }
		}
	}
	return best
}

type UniqueLocation =
	| { kind: "unique"; tier: MatchTier; start: number }
	| { kind: "ambiguous"; tier: MatchTier; starts: number[] }
	| { kind: "not_found" }

function locateUnique(lines: readonly IndexedLine[], search: readonly SearchLine[]): UniqueLocation {
	for (const tier of MATCH_TIERS) {
		const starts = findCandidateStarts(lines, search, LINE_MATCHERS[tier])
		if (starts.length === 1) {
			return { kind: "unique", tier, start: starts[0] }
		}
		if (starts.length > 1) {
			// Looser tiers only add candidates, so they cannot resolve the ambiguity.
			return { kind: "ambiguous", tier, starts }
		}
	}
	return { kind: "not_found" }
}

function locateNearest(
	lines: readonly IndexedLine[],
	search: readonly SearchLine[],
	fromLine: number,
): { tier: MatchTier; start: number } | undefined {
	for (const tier of MATCH_TIERS) {
		const start = findFirstStart(lines, search, LINE_MATCHERS[tier], fromLine)
		if (start !== undefined) {
			return { tier, start }
		}
	}
	return undefined
}

function findCandidateStarts(lines: readonly IndexedLine[], search: readonly SearchLine[], matcher: LineMatcher): number[] {
	const starts: number[] = []
	for (let start = 0; start + search.length <= lines.length; start++) {
		if (matchesAt(lines, search, matcher, start)) {
			starts.push(start)
		}
	}
	return starts
}

function findFirstStart(
	lines: readonly IndexedLine[],
	search: readonly SearchLine[],
	matcher: LineMatcher,
	fromLine: number,
): number | undefined {
	for (let start = fromLine; start + search.length <= lines.length; start++) {
		if (matchesAt(lines, search, matcher, start)) {
			return start
		}
	}
	return undefined
}

function matchesAt(lines: readonly IndexedLine[], search: readonly SearchLine[], matcher: LineMatcher, start: number): boolean {
	for (let offset = 0; offset < search.length; offset++) {
		if (!matcher(lines[start + offset], search[offset])) {
			return false
		}
	}
	return true
}

function uniqueMatch(
	index: FileLineIndex,
	tier: MatchTier,
	startLineIndex: number,
	endLineIndex: number,
	skippedLines: number,
): SearchMatch {
	return { kind: "unique", tier, range: index.rangeOf(startLineIndex, endLineIndex), skippedLines }
}

function looserTier(a: MatchTier, b: MatchTier): MatchTier {
	return MATCH_TIERS.indexOf(a) >= MATCH_TIERS.indexOf(b) ? a : b
}

function normalizeSearchLines(lines: readonly string[]): SearchLine[] {
	return lines.map((line) => {
		const text = stripCarriageReturn(line)
		return { text, trimmed: text.trim() }
	})
}

function indexLines(content: string): IndexedLine[] {
	const lines: IndexedLine[] = []
	let start = 0
	while (start < content.length) {
		const newline = content.indexOf("\n", start)
		const contentEnd = newline === -1 ? content.length : newline
		const end = newline === -1 ? content.length : newline + 1
		const text = stripCarriageReturn(content.slice(start, contentEnd))
		lines.push({ text, trimmed: text.trim(), trimmedStart: text.trimStart(), start, end })
		start = end
	}
	return lines
}

function stripCarriageReturn(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line
}
