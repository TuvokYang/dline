import { renderPrompt } from "@core/prompts/i18n"
import type { PromptEnv } from "@core/prompts/template/types"
import {
	type BlockSection,
	describeMarkerProblem,
	explainSearchNotFound,
	findMarkerProblem,
	formatLineCount,
	skipMarkerFor,
	withFindings,
} from "./diff-diagnostics"
import {
	FileLineIndex,
	type LineRange,
	type MatchTier,
	matchSearchBlock,
	type SearchMatch,
	type SearchPattern,
} from "./diff-matcher"

const SEARCH_BLOCK_START = "------- SEARCH"
const SEARCH_BLOCK_END = "======="

/**
 * Structured diff block returned from SEARCH/REPLACE parsing.
 * Used by the frontend for direct rendering without re-parsing.
 */
export interface DiffBlock {
	/** Lines in the SEARCH section (original content to find) */
	searchLines: string[]
	/** Lines in the REPLACE section (new content to replace with) */
	replaceLines: string[]
	/** 1-based line number where the match starts in the original file */
	matchStartLine: number
	/** Matching strategy used: "exact" | "line_trim" | "block_anchor" | "empty" */
	status: "exact" | "line_trim" | "block_anchor" | "empty"
}

/**
 * A single parsed SEARCH/REPLACE block produced by the unified diff state machine.
 * Contains both raw text (for error display) and structured data (for matching).
 */
export interface ParsedBlock {
	/** Full original block text including delimiters (for error display) */
	rawText: string
	/** SEARCH section content lines (no delimiter prefix, no +/- prefix) */
	searchText: string
	/** REPLACE section content lines (no delimiter prefix, no +/- prefix) */
	replaceText: string
	/** 1-based line number where the SEARCH matched, 0 if unmatched */
	startLine: number
	/** Whether this block has a parsing/matching error */
	hasError: boolean
	/** Error code from DIFF_ERROR_CODE, undefined if no error */
	errorCode?: string
	/** Full error message for API response (formatResponse.toolError) */
	errorMessage?: string
	/** 1-based inclusive last line of the replaced range, present on success */
	endLine?: number
	/** Original file lines replaced by this block, joined with "\n" without the final terminator */
	matchedText?: string
	/** Matching tier that located the block, present on success */
	matchTier?: MatchTier
	/** Lines deleted between the SKIP head and tail, 0 for ordinary blocks */
	skippedLines?: number
}

/**
 * Result from the unified diff parser (constructNewFileContent).
 * Consumed by both the webview renderer and file modification logic.
 */
export interface DiffResult {
	/** Parsed blocks with metadata (per-block errors in ParsedBlock.errorMessage) */
	blocks: ParsedBlock[]
	/** Full new file content after applying all successful blocks */
	newContent: string
}

/**
 * Error codes for SEARCH/REPLACE diff parsing failures.
 * Shared by constructNewFileContent (API result) and StreamingDiffParser (webview).
 * All values use UPPER_CASE for consistency across modules.
 */
export const DIFF_ERROR_CODE = {
	// Common: constructNewFileContent + StreamingDiffParser
	SEARCH_NOT_FOUND: "SEARCH_NOT_FOUND",
	EMPTY_SEARCH_CONTENT_CONFLICT: "EMPTY_SEARCH_CONTENT_CONFLICT",
	DELIMITER_CONFLICT: "DELIMITER_CONFLICT",
	DELIMITER_MISMATCH: "DELIMITER_MISMATCH",
	DELIMITER_TOO_SHORT: "DELIMITER_TOO_SHORT",
	UNCLOSED_SEARCH: "UNCLOSED_SEARCH",
	UNCLOSED_REPLACE: "UNCLOSED_REPLACE",
	BLOCK_OVERLAP: "BLOCK_OVERLAP",
	BLOCK_OUT_OF_ORDER: "BLOCK_OUT_OF_ORDER",
	AMBIGUOUS_MATCH: "AMBIGUOUS_MATCH",
	INVALID_SKIP_MARKER: "INVALID_SKIP_MARKER",
	EMPTY_SEARCH: "EMPTY_SEARCH",
	// StreamingDiffParser-only: real-time streaming detection
	EXTRA_CLOSE_MARKER: "EXTRA_CLOSE_MARKER",
	NESTED_SEARCH_MARKER: "NESTED_SEARCH_MARKER",
	MISSING_SEPARATOR: "MISSING_SEPARATOR",
	SEARCH_MARKER_IN_REPLACE: "SEARCH_MARKER_IN_REPLACE",
	FINAL_VALIDATION: "FINAL_VALIDATION",
} as const

export type DiffErrorCode = (typeof DIFF_ERROR_CODE)[keyof typeof DIFF_ERROR_CODE]

/**
 * Structured error thrown by constructNewFileContent when SEARCH/REPLACE parsing fails.
 * Carries a machine-readable code so callers can route to correct diagnostics.
 */
export class DiffError extends Error {
	public readonly code: DiffErrorCode

	constructor(code: DiffErrorCode, message: string) {
		super(message)
		this.code = code
		this.name = "DiffError"
	}
}

const REPLACE_BLOCK_END = "+++++++ REPLACE"

/**
 * Converts a character index in a string to a 1-based line number.
 * @param content - The full content string
 * @param charIndex - The character index in the content
 * @returns The 1-based line number where charIndex falls
 */
export function getLineNumberFromCharIndex(content: string, charIndex: number): number {
	if (charIndex <= 0) return 1
	return content.substring(0, charIndex).split("\n").length
}

const SEARCH_BLOCK_CHAR = "-"
const REPLACE_BLOCK_CHAR = "+"
const LEGACY_SEARCH_BLOCK_CHAR = "<"
const LEGACY_REPLACE_BLOCK_CHAR = ">"

// Replace the exact string constants with flexible regex patterns
const SEARCH_BLOCK_START_REGEX = /^[-]{7,} SEARCH>?$/
const LEGACY_SEARCH_BLOCK_START_REGEX = /^[<]{7,} SEARCH>?$/
const SHORT_SEARCH_START_REGEX = /^[-]{1,6} SEARCH>?$/
const LEGACY_SHORT_SEARCH_START_REGEX = /^[<]{1,6} SEARCH>?$/

const SEARCH_BLOCK_END_REGEX = /^[=]{7,}$/

const REPLACE_BLOCK_END_REGEX = /^[+]{7,} REPLACE>?$/
const LEGACY_REPLACE_BLOCK_END_REGEX = /^[>]{7,} REPLACE>?$/

// Count leading occurrences of a character
function countLeadingChar(ch: string, line: string): number {
	let count = 0
	while (count < line.length && line[count] === ch) {
		count++
	}
	return count
}

// Helper functions to check if a line matches the flexible patterns
function isSearchBlockStart(line: string): boolean {
	return SEARCH_BLOCK_START_REGEX.test(line) || LEGACY_SEARCH_BLOCK_START_REGEX.test(line)
}

/** Check if line is a complete SEARCH marker with too few delimiters. */
function isShortSearchStart(line: string): boolean {
	return SHORT_SEARCH_START_REGEX.test(line) || LEGACY_SHORT_SEARCH_START_REGEX.test(line)
}

/** Count the SEARCH marker delimiter characters for dash and legacy markers. */
function countSearchDelimiter(line: string): number {
	const trimmed = line.trimStart()
	if (trimmed.startsWith(SEARCH_BLOCK_CHAR)) return countLeadingChar(SEARCH_BLOCK_CHAR, trimmed)
	if (trimmed.startsWith(LEGACY_SEARCH_BLOCK_CHAR)) return countLeadingChar(LEGACY_SEARCH_BLOCK_CHAR, trimmed)
	return 0
}

/** Check if line is a SEARCH marker with EXACT dash count matching expectedN. */
function isSearchBlockStartExact(line: string, expectedN: number): boolean {
	const trimmed = line.trimStart()
	const dashCount = countLeadingChar("-", trimmed)
	if (dashCount !== expectedN) return false
	const after = trimmed.slice(dashCount)
	return /^ SEARCH>?$/.test(after)
}

function isSearchBlockEnd(line: string, expectedN?: number): boolean {
	// When expectedN is set, use exact count to avoid false positives
	// on SEARCH content that contains "=======" with a different N.
	if (expectedN && expectedN >= 7) {
		const trimmed = line.trimStart()
		const eqCount = countLeadingChar("=", trimmed)
		return eqCount === expectedN && trimmed.length === expectedN
	}
	return SEARCH_BLOCK_END_REGEX.test(line)
}

function isReplaceBlockEnd(line: string, expectedN?: number): boolean {
	// When expectedN is set, use exact count to avoid false positives
	if (expectedN && expectedN >= 7) {
		const trimmed = line.trimStart()
		const plusCount = countLeadingChar("+", trimmed)
		const after = trimmed.slice(plusCount)
		return plusCount === expectedN && /^ REPLACE>?$/.test(after)
	}
	return REPLACE_BLOCK_END_REGEX.test(line) || LEGACY_REPLACE_BLOCK_END_REGEX.test(line)
}

/**
 * Attempts a line-trimmed fallback match for the given search content in the original content.
 * It tries to match `searchContent` lines against a block of lines in `originalContent` starting
 * from `lastProcessedIndex`. Lines are matched by trimming leading/trailing whitespace and ensuring
 * they are identical afterwards.
 *
 * Returns [matchIndexStart, matchIndexEnd] if found, or false if not found.
 */
function lineTrimmedFallbackMatch(originalContent: string, searchContent: string, startIndex: number): [number, number] | false {
	// Split both contents into lines
	const originalLines = originalContent.split("\n")
	const searchLines = searchContent.split("\n")

	// Trim trailing empty line if exists (from the trailing \n in searchContent)
	if (searchLines[searchLines.length - 1] === "") {
		searchLines.pop()
	}

	// Find the line number where startIndex falls
	let startLineNum = 0
	let currentIndex = 0
	while (currentIndex < startIndex && startLineNum < originalLines.length) {
		currentIndex += originalLines[startLineNum].length + 1 // +1 for \n
		startLineNum++
	}

	// For each possible starting position in original content
	for (let i = startLineNum; i <= originalLines.length - searchLines.length; i++) {
		let matches = true

		// Try to match all search lines from this position
		for (let j = 0; j < searchLines.length; j++) {
			const originalTrimmed = originalLines[i + j].trim()
			const searchTrimmed = searchLines[j].trim()

			if (originalTrimmed !== searchTrimmed) {
				matches = false
				break
			}
		}

		// If we found a match, calculate the exact character positions
		if (matches) {
			// Find start character index
			let matchStartIndex = 0
			for (let k = 0; k < i; k++) {
				matchStartIndex += originalLines[k].length + 1 // +1 for \n
			}

			// Find end character index
			let matchEndIndex = matchStartIndex
			for (let k = 0; k < searchLines.length; k++) {
				matchEndIndex += originalLines[i + k].length + 1 // +1 for \n
			}

			return [matchStartIndex, matchEndIndex]
		}
	}

	return false
}

/**
 * Attempts to match blocks of code by using the first and last lines as anchors.
 * This is a third-tier fallback strategy that helps match blocks where we can identify
 * the correct location by matching the beginning and end, even if the exact content
 * differs slightly.
 *
 * The matching strategy:
 * 1. Only attempts to match blocks of 3 or more lines to avoid false positives
 * 2. Extracts from the search content:
 *    - First line as the "start anchor"
 *    - Last line as the "end anchor"
 * 3. For each position in the original content:
 *    - Checks if the next line matches the start anchor
 *    - If it does, jumps ahead by the search block size
 *    - Checks if that line matches the end anchor
 *    - All comparisons are done after trimming whitespace
 *
 * This approach is particularly useful for matching blocks of code where:
 * - The exact content might have minor differences
 * - The beginning and end of the block are distinctive enough to serve as anchors
 * - The overall structure (number of lines) remains the same
 *
 * @param originalContent - The full content of the original file
 * @param searchContent - The content we're trying to find in the original file
 * @param startIndex - The character index in originalContent where to start searching
 * @returns A tuple of [startIndex, endIndex] if a match is found, false otherwise
 */
function blockAnchorFallbackMatch(originalContent: string, searchContent: string, startIndex: number): [number, number] | false {
	const originalLines = originalContent.split("\n")
	const searchLines = searchContent.split("\n")

	// Only use this approach for blocks of 3+ lines
	if (searchLines.length < 3) {
		return false
	}

	// Trim trailing empty line if exists
	if (searchLines[searchLines.length - 1] === "") {
		searchLines.pop()
	}

	const firstLineSearch = searchLines[0].trim()
	const lastLineSearch = searchLines[searchLines.length - 1].trim()
	const searchBlockSize = searchLines.length

	// Find the line number where startIndex falls
	let startLineNum = 0
	let currentIndex = 0
	while (currentIndex < startIndex && startLineNum < originalLines.length) {
		currentIndex += originalLines[startLineNum].length + 1
		startLineNum++
	}

	// Look for matching start and end anchors
	for (let i = startLineNum; i <= originalLines.length - searchBlockSize; i++) {
		// Check if first line matches
		if (originalLines[i].trim() !== firstLineSearch) {
			continue
		}

		// Check if last line matches at the expected position
		if (originalLines[i + searchBlockSize - 1].trim() !== lastLineSearch) {
			continue
		}

		// Calculate exact character positions
		let matchStartIndex = 0
		for (let k = 0; k < i; k++) {
			matchStartIndex += originalLines[k].length + 1
		}

		let matchEndIndex = matchStartIndex
		for (let k = 0; k < searchBlockSize; k++) {
			matchEndIndex += originalLines[i + k].length + 1
		}

		return [matchStartIndex, matchEndIndex]
	}

	return false
}

/**
 * This function reconstructs the file content by applying a streamed diff (in a
 * specialized SEARCH/REPLACE block format) to the original file content. It is designed
 * to handle both incremental updates and the final resulting file after all chunks have
 * been processed.
 *
 * The diff format is a custom structure that uses three markers to define changes:
 *
 *   ------- SEARCH
 *   [Exact content to find in the original file]
 *   =======
 *   [Content to replace with]
 *   +++++++ REPLACE
 *
 * Behavior and Assumptions:
 * 1. The file is processed chunk-by-chunk. Each chunk of `diffContent` may contain
 *    partial or complete SEARCH/REPLACE blocks. By calling this function with each
 *    incremental chunk (with `isFinal` indicating the last chunk), the final reconstructed
 *    file content is produced.
 *
 * 2. Matching Strategy (in order of attempt):
 *    a. Exact Match: First attempts to find the exact SEARCH block text in the original file
 *    b. Line-Trimmed Match: Falls back to line-by-line comparison ignoring leading/trailing whitespace
 *    c. Block Anchor Match: For blocks of 3+ lines, tries to match using first/last lines as anchors
 *    If all matching strategies fail, an error is thrown.
 *
 * 3. Empty SEARCH Section:
 *    - If SEARCH is empty and the original file is empty, this indicates creating a new file
 *      (pure insertion).
 *    - If SEARCH is empty and the original file is not empty, this indicates a complete
 *      file replacement (the entire original content is considered matched and replaced).
 *
 * 4. Applying Changes:
 *    - Before encountering the "=======" marker, lines are accumulated as search content.
 *    - After "=======" and before ">>>>>>> REPLACE", lines are accumulated as replacement content.
 *    - Once the block is complete (">>>>>>> REPLACE"), the matched section in the original
 *      file is replaced with the accumulated replacement lines, and the position in the original
 *      file is advanced.
 *
 * 5. Incremental Output:
 *    - As soon as the match location is found and we are in the REPLACE section, each new
 *      replacement line is appended to the result so that partial updates can be viewed
 *      incrementally.
 *
 * 6. Partial Markers:
 *    - If the final line of the chunk looks like it might be part of a marker but is not one
 *      of the known markers, it is removed. This prevents incomplete or partial markers
 *      from corrupting the output.
 *
 * 7. Finalization:
 *    - Once all chunks have been processed (when `isFinal` is true), any remaining original
 *      content after the last replaced section is appended to the result.
 *    - Trailing newlines are not forcibly added. The code tries to output exactly what is specified.
 *
 * Errors:
 * - If the search block cannot be matched using any of the available matching strategies,
 *   an error is thrown.
 */
export async function constructNewFileContent(
	diffContent: string,
	originalContent: string,
	isFinal: boolean,
	version: "v1" | "v2" = "v1",
): Promise<DiffResult> {
	const constructor = constructNewFileContentVersionMapping[version]
	if (!constructor) {
		throw new Error(`Invalid version '${version}' for file content constructor`)
	}
	const rawResult = await constructor(diffContent, originalContent, isFinal)

	// Split raw diff into individual blocks by SEARCH markers for rawText
	const rawBlocks = diffContent.split(/(?=\n*------- SEARCH)/).filter((b) => b.trim())

	const parsedBlocks: ParsedBlock[] = rawBlocks.map((rawText, i) => {
		const diffBlock = rawResult.blocks[i]
		const hasError = !diffBlock || diffBlock.status === "empty"

		return {
			rawText: rawText.trim(),
			searchText: diffBlock ? diffBlock.searchLines.join("\n") : "",
			replaceText: diffBlock ? diffBlock.replaceLines.join("\n") : "",
			startLine: diffBlock ? diffBlock.matchStartLine : 0,
			hasError,
			errorCode: hasError && rawResult.error ? rawResult.error.code : undefined,
			errorMessage: hasError && rawResult.error ? rawResult.error.message : undefined,
		}
	})

	return {
		blocks: parsedBlocks,
		newContent: rawResult.newContent,
	}
}

const constructNewFileContentVersionMapping: Record<
	string,
	(
		diffContent: string,
		originalContent: string,
		isFinal: boolean,
	) => Promise<{ newContent: string; matchIndices: number[]; blocks: DiffBlock[]; error?: DiffError }>
> = {
	v1: constructNewFileContentV1,
	v2: constructNewFileContentV2,
} as const

async function constructNewFileContentV1(
	diffContent: string,
	originalContent: string,
	isFinal: boolean,
): Promise<{ newContent: string; matchIndices: number[]; blocks: DiffBlock[]; error?: DiffError }> {
	let diffError: DiffError | undefined
	let result = ""
	let lastProcessedIndex = 0

	let currentSearchContent = ""
	let currentReplaceContent = ""
	let inSearch = false
	let inReplace = false

	let searchMatchIndex = -1
	let searchEndIndex = -1
	let blockDelimiterCount = 0 // Locked delimiter count per block for consistency validation

	// Track all replacements for overlap validation and structured frontend output
	const replacements: Array<{
		start: number
		end: number
		content: string
		searchLines: string[]
		replaceLines: string[]
		matchStartLine: number
		status: DiffBlock["status"]
	}> = []
	/** Current block's matching strategy, set during SEARCH→REPLACE transition */
	let currentMatchStatus: DiffBlock["status"] = "exact"
	/** Current block index for error messages (1-based) */
	let currentBlockIndex = 0

	const lines = diffContent.split("\n")

	// If the last line looks like a partial marker but isn't recognized,
	// remove it because it might be incomplete.
	const lastLine = lines[lines.length - 1]
	if (
		lines.length > 0 &&
		(lastLine.startsWith(SEARCH_BLOCK_CHAR) ||
			lastLine.startsWith(LEGACY_SEARCH_BLOCK_CHAR) ||
			lastLine.startsWith("=") ||
			lastLine.startsWith(REPLACE_BLOCK_CHAR) ||
			lastLine.startsWith(LEGACY_REPLACE_BLOCK_CHAR)) &&
		!isShortSearchStart(lastLine) &&
		!isSearchBlockStart(lastLine) &&
		!isSearchBlockEnd(lastLine) &&
		!isReplaceBlockEnd(lastLine)
	) {
		lines.pop()
	}

	for (const line of lines) {
		if (!inSearch && !inReplace && isShortSearchStart(line)) {
			blockDelimiterCount = countSearchDelimiter(line)
			throw new DiffError(
				DIFF_ERROR_CODE.DELIMITER_TOO_SHORT,
				renderPrompt("replaceInFile", "diffDelimiterTooShort", { COUNT: String(blockDelimiterCount) }),
			)
		}

		if (!inSearch && !inReplace && isSearchBlockStart(line)) {
			inSearch = true
			currentSearchContent = ""
			currentReplaceContent = ""
			currentBlockIndex++
			blockDelimiterCount = countSearchDelimiter(line)
			if (blockDelimiterCount < 7) {
				throw new DiffError(
					DIFF_ERROR_CODE.DELIMITER_TOO_SHORT,
					renderPrompt("replaceInFile", "diffDelimiterTooShort", { COUNT: String(blockDelimiterCount) }),
				)
			}
			continue
		}

		if (inSearch && isSearchBlockEnd(line, blockDelimiterCount)) {
			const endCount = countLeadingChar("=", line.trimStart())
			if (endCount !== blockDelimiterCount) {
				throw new DiffError(
					DIFF_ERROR_CODE.DELIMITER_MISMATCH,
					renderPrompt("replaceInFile", "diffDelimiterMismatch", {
						SEARCH_N: String(blockDelimiterCount),
						CLOSE_N: String(endCount),
					}),
				)
			}
			// Check delimiter uniqueness in SEARCH content
			for (const contentLine of currentSearchContent.split("\n")) {
				const trimmed = contentLine.trimStart()
				const dashCount = countLeadingChar("-", trimmed)
				const eqCount = countLeadingChar("=", trimmed)
				const plusCount = countLeadingChar("+", trimmed)
				if (dashCount === blockDelimiterCount && /^[-]{7,} SEARCH>?$/.test(trimmed)) {
					throw new DiffError(
						DIFF_ERROR_CODE.DELIMITER_CONFLICT,
						renderPrompt("replaceInFile", "diffDelimiterConflict", {
							BLOCK_TYPE: "SEARCH",
							COUNT: String(dashCount),
							CHAR: "-",
						}),
					)
				}
				if (eqCount === blockDelimiterCount && /^[=]{7,}$/.test(trimmed)) {
					throw new DiffError(
						DIFF_ERROR_CODE.DELIMITER_CONFLICT,
						renderPrompt("replaceInFile", "diffDelimiterConflict", {
							BLOCK_TYPE: "SEARCH",
							COUNT: String(eqCount),
							CHAR: "=",
						}),
					)
				}
				if (plusCount === blockDelimiterCount && /^[+]{7,} REPLACE>?$/.test(trimmed)) {
					throw new DiffError(
						DIFF_ERROR_CODE.DELIMITER_CONFLICT,
						renderPrompt("replaceInFile", "diffDelimiterConflict", {
							BLOCK_TYPE: "SEARCH",
							COUNT: String(plusCount),
							CHAR: "+",
						}),
					)
				}
			}
			inSearch = false
			inReplace = true

			// Remove trailing linebreak for adding the === marker
			// if (currentSearchContent.endsWith("\r\n")) {
			// 	currentSearchContent = currentSearchContent.slice(0, -2)
			// } else if (currentSearchContent.endsWith("\n")) {
			// 	currentSearchContent = currentSearchContent.slice(0, -1)
			// }

			if (!currentSearchContent) {
				// Empty search block
				if (originalContent.length === 0) {
					// New file scenario: nothing to match, just start inserting
					searchMatchIndex = 0
					searchEndIndex = 0
					currentMatchStatus = "empty"
				} else {
					// Empty SEARCH with non-empty file: SEARCH content may have been consumed as delimiter
					throw new DiffError(
						DIFF_ERROR_CODE.EMPTY_SEARCH_CONTENT_CONFLICT,
						renderPrompt("replaceInFile", "diffEmptySearchContentConflict"),
					)
				}
			} else {
				// Add check for inefficient full-file search
				// if (currentSearchContent.trim() === originalContent.trim()) {
				// 	throw new Error(
				// 		"The SEARCH block contains the entire file content. Please either:\n" +
				// 			"1. Use an empty SEARCH block to replace the entire file, or\n" +
				// 			"2. Make focused changes to specific parts of the file that need modification.",
				// 	)
				// }

				// Exact search match scenario
				const exactIndex = originalContent.indexOf(currentSearchContent, lastProcessedIndex)
				if (exactIndex !== -1) {
					searchMatchIndex = exactIndex
					searchEndIndex = exactIndex + currentSearchContent.length
					currentMatchStatus = "exact"
				} else {
					// Attempt fallback line-trimmed matching
					const lineMatch = lineTrimmedFallbackMatch(originalContent, currentSearchContent, lastProcessedIndex)
					if (lineMatch) {
						searchMatchIndex = (lineMatch as [number, number])[0]
						searchEndIndex = (lineMatch as [number, number])[1]
						currentMatchStatus = "line_trim"
					} else {
						// Try block anchor fallback for larger blocks
						const blockMatch = blockAnchorFallbackMatch(originalContent, currentSearchContent, lastProcessedIndex)
						if (blockMatch) {
							searchMatchIndex = (blockMatch as [number, number])[0]
							searchEndIndex = (blockMatch as [number, number])[1]
							currentMatchStatus = "block_anchor"
						} else {
							// Check overlap before reporting SEARCH_NOT_FOUND
							let isOverlap = false
							for (const existing of replacements) {
								const existingLines = existing.searchLines
								const searchContentLines = currentSearchContent.split("\n").filter((l) => l !== "")
								for (const sLine of searchContentLines) {
									if (existingLines.some((eLine) => eLine.trim() === sLine.trim())) {
										isOverlap = true
										break
									}
								}
								if (isOverlap) break
							}
							if (isOverlap) {
								diffError = new DiffError(
									DIFF_ERROR_CODE.BLOCK_OVERLAP,
									renderPrompt("replaceInFile", "diffBlockOverlap", {
										BLOCK_INDEX: String(currentBlockIndex),
										PREV_INDEX: String(1),
									}),
								)
								result += originalContent.slice(lastProcessedIndex)
								return {
									newContent: result,
									matchIndices: replacements.map((r) => r.start),
									blocks: replacements.map((r) => ({
										searchLines: r.searchLines,
										replaceLines: r.replaceLines,
										matchStartLine: r.matchStartLine,
										status: r.status,
									})),
									error: diffError,
								}
							}
							throw new DiffError(
								DIFF_ERROR_CODE.SEARCH_NOT_FOUND,
								renderPrompt("replaceInFile", "diffSearchNotFound", {
									LINE_COUNT: formatLineCount(currentSearchContent.split("\n").filter((l) => l).length),
								}),
							)
						}
					}
				}
			}

			// Reject out-of-order replacements: blocks must match in file order
			// to prevent disordered edits and overlapping ranges.
			if (searchMatchIndex < lastProcessedIndex) {
				throw new DiffError(
					DIFF_ERROR_CODE.BLOCK_OUT_OF_ORDER,
					renderPrompt("replaceInFile", "diffBlockOutOfOrder", { BLOCK_INDEX: String(currentBlockIndex) }),
				)
			}

			// Check for overlap with previously stored replacements
			for (const existing of replacements) {
				if (searchMatchIndex < existing.end && searchEndIndex > existing.start) {
					diffError = new DiffError(
						DIFF_ERROR_CODE.BLOCK_OVERLAP,
						renderPrompt("replaceInFile", "diffBlockOverlap", {
							BLOCK_INDEX: String(currentBlockIndex),
							PREV_INDEX: String(replacements.indexOf(existing) + 1),
						}),
					)
					result += originalContent.slice(lastProcessedIndex)
					return {
						newContent: result,
						matchIndices: replacements.map((r) => r.start),
						blocks: replacements.map((r) => ({
							searchLines: r.searchLines,
							replaceLines: r.replaceLines,
							matchStartLine: r.matchStartLine,
							status: r.status,
						})),
						error: diffError,
					}
				}
			}

			// Output everything up to the match location
			result += originalContent.slice(lastProcessedIndex, searchMatchIndex)
			continue
		}

		if (inReplace && isReplaceBlockEnd(line, blockDelimiterCount)) {
			const replaceCount = countLeadingChar("+", line.trimStart())
			if (replaceCount !== blockDelimiterCount) {
				throw new DiffError(
					DIFF_ERROR_CODE.DELIMITER_MISMATCH,
					renderPrompt("replaceInFile", "diffDelimiterMismatch", {
						SEARCH_N: String(blockDelimiterCount),
						CLOSE_N: String(replaceCount),
					}),
				)
			}
			// Finished one replace block

			if (searchMatchIndex === -1) {
				throw new DiffError(DIFF_ERROR_CODE.UNCLOSED_SEARCH, renderPrompt("replaceInFile", "diffUnclosedSearch"))
			}

			// Store this replacement with structured diff block info for frontend rendering
			// Extract search/replace lines (remove trailing empty line from \n accumulation)
			const searchLinesRaw = currentSearchContent.split("\n")
			if (searchLinesRaw[searchLinesRaw.length - 1] === "") searchLinesRaw.pop()
			const replaceLinesRaw = currentReplaceContent.split("\n")
			if (replaceLinesRaw[replaceLinesRaw.length - 1] === "") replaceLinesRaw.pop()
			const matchStartLine = searchMatchIndex >= 0 ? getLineNumberFromCharIndex(originalContent, searchMatchIndex) : 1

			replacements.push({
				start: searchMatchIndex,
				end: searchEndIndex,
				content: currentReplaceContent,
				searchLines: searchLinesRaw,
				replaceLines: replaceLinesRaw,
				matchStartLine,
				status: currentMatchStatus,
			})

			// Reset match status for next block
			currentMatchStatus = "exact"

			lastProcessedIndex = searchEndIndex

			// Reset for next block
			inSearch = false
			inReplace = false
			currentSearchContent = ""
			currentReplaceContent = ""
			searchMatchIndex = -1
			searchEndIndex = -1
			continue
		}

		// Accumulate content for search or replace
		// (currentReplaceContent is not being used for anything right now since we directly append to result.)
		// (We artificially add a linebreak since we split on \n at the beginning. In order to not include a trailing linebreak in the final search/result blocks we need to remove it before using them. This allows for partial line matches to be correctly identified.)
		// NOTE: search/replace blocks must be arranged in the order they appear in the file due to how we build the content using lastProcessedIndex. We also cannot strip the trailing newline since for non-partial lines it would remove the linebreak from the original content. (If we remove end linebreak from search, then we'd also have to remove it from replace but we can't know if it's a partial line or not since the model may be using the line break to indicate the end of the block rather than as part of the search content.) We require the model to output full lines in order for our fallbacks to work as well.
		if (inSearch) {
			currentSearchContent += `${line}\n`
		} else if (inReplace) {
			// Check delimiter conflict in REPLACE content (same rules as SEARCH content)
			const trimmed = line.trimStart()
			const dashCount = countLeadingChar("-", trimmed)
			const eqCount = countLeadingChar("=", trimmed)
			const plusCount = countLeadingChar("+", trimmed)
			if (dashCount === blockDelimiterCount && /^[-]{7,} SEARCH>?$/.test(trimmed)) {
				throw new DiffError(
					DIFF_ERROR_CODE.DELIMITER_CONFLICT,
					renderPrompt("replaceInFile", "diffDelimiterConflict", {
						BLOCK_TYPE: "REPLACE",
						COUNT: String(dashCount),
						CHAR: "-",
					}),
				)
			}
			if (eqCount === blockDelimiterCount && /^[=]{7,}$/.test(trimmed)) {
				throw new DiffError(
					DIFF_ERROR_CODE.DELIMITER_CONFLICT,
					renderPrompt("replaceInFile", "diffDelimiterConflict", {
						BLOCK_TYPE: "REPLACE",
						COUNT: String(eqCount),
						CHAR: "=",
					}),
				)
			}
			if (plusCount === blockDelimiterCount && /^[+]{7,} REPLACE>?$/.test(trimmed)) {
				throw new DiffError(
					DIFF_ERROR_CODE.DELIMITER_CONFLICT,
					renderPrompt("replaceInFile", "diffDelimiterConflict", {
						BLOCK_TYPE: "REPLACE",
						COUNT: String(plusCount),
						CHAR: "+",
					}),
				)
			}
			currentReplaceContent += `${line}\n`
			// Output replacement lines immediately once match is found
			if (searchMatchIndex !== -1) {
				result += `${line}\n`
			}
		}
	}

	// If this is the final chunk, validate that all blocks are complete.
	// Unclosed SEARCH or REPLACE blocks at finalization indicate a malformed
	// diff from the model and must be rejected rather than auto-closed.
	if (isFinal) {
		if (inSearch) {
			throw new DiffError(DIFF_ERROR_CODE.UNCLOSED_SEARCH, renderPrompt("replaceInFile", "diffUnclosedSearch"))
		}
		if (inReplace) {
			throw new DiffError(DIFF_ERROR_CODE.UNCLOSED_REPLACE, renderPrompt("replaceInFile", "diffUnclosedReplace"))
		}

		result += originalContent.slice(lastProcessedIndex)
	}

	// Return structured diff block info for frontend rendering
	return {
		newContent: result,
		matchIndices: replacements.map((r) => r.start),
		blocks: replacements.map((r) => ({
			searchLines: r.searchLines,
			replaceLines: r.replaceLines,
			matchStartLine: r.matchStartLine,
			status: r.status,
		})),
		error: diffError,
	}
}

enum ProcessingState {
	Idle = 0,
	StateSearch = 1 << 0,
	StateReplace = 1 << 1,
}

class NewFileContentConstructor {
	private originalContent: string
	private isFinal: boolean
	private state: number
	private pendingNonStandardLines: string[]
	private result: string
	private lastProcessedIndex: number
	private currentSearchContent: string
	private searchMatchIndex: number
	private searchEndIndex: number
	private blockDelimiterCount: number

	constructor(originalContent: string, isFinal: boolean) {
		this.originalContent = originalContent
		this.isFinal = isFinal
		this.pendingNonStandardLines = []
		this.result = ""
		this.lastProcessedIndex = 0
		this.state = ProcessingState.Idle
		this.currentSearchContent = ""
		this.searchMatchIndex = -1
		this.searchEndIndex = -1
		this.blockDelimiterCount = 0
	}

	private resetForNextBlock() {
		// Reset for next block
		this.state = ProcessingState.Idle
		this.currentSearchContent = ""
		this.searchMatchIndex = -1
		this.searchEndIndex = -1
	}

	private findLastMatchingLineIndex(regx: RegExp, lineLimit: number) {
		for (let i = lineLimit; i > 0; ) {
			i--
			if (this.pendingNonStandardLines[i].match(regx)) {
				return i
			}
		}
		return -1
	}

	private updateProcessingState(newState: ProcessingState) {
		const isValidTransition =
			(this.state === ProcessingState.Idle && newState === ProcessingState.StateSearch) ||
			(this.state === ProcessingState.StateSearch && newState === ProcessingState.StateReplace)

		if (!isValidTransition) {
			throw new DiffError(DIFF_ERROR_CODE.UNCLOSED_SEARCH, renderPrompt("replaceInFile", "diffUnclosedSearch"))
		}

		this.state |= newState
	}

	private isStateActive(state: ProcessingState): boolean {
		return (this.state & state) === state
	}

	private activateReplaceState() {
		this.updateProcessingState(ProcessingState.StateReplace)
	}

	private activateSearchState() {
		this.updateProcessingState(ProcessingState.StateSearch)
		this.currentSearchContent = ""
	}

	private isSearchingActive(): boolean {
		return this.isStateActive(ProcessingState.StateSearch)
	}

	private isReplacingActive(): boolean {
		return this.isStateActive(ProcessingState.StateReplace)
	}

	private hasPendingNonStandardLines(pendingNonStandardLineLimit: number): boolean {
		return this.pendingNonStandardLines.length - pendingNonStandardLineLimit < this.pendingNonStandardLines.length
	}

	public processLine(line: string) {
		this.internalProcessLine(line, true, this.pendingNonStandardLines.length)
	}

	public getResult(): { newContent: string; matchIndices: number[]; blocks: DiffBlock[] } {
		// If this is the final chunk, append any remaining original content
		if (this.isFinal && this.lastProcessedIndex < this.originalContent.length) {
			this.result += this.originalContent.slice(this.lastProcessedIndex)
		}
		if (this.isFinal && this.state !== ProcessingState.Idle) {
			throw new DiffError(DIFF_ERROR_CODE.UNCLOSED_SEARCH, renderPrompt("replaceInFile", "diffUnclosedSearch"))
		}
		// Note: V2 implementation doesn't currently track match indices or diff blocks
		return { newContent: this.result, matchIndices: [], blocks: [] }
	}

	private internalProcessLine(
		line: string,
		canWritependingNonStandardLines: boolean,
		pendingNonStandardLineLimit: number,
	): number {
		let removeLineCount = 0
		if (!this.isSearchingActive() && !this.isReplacingActive() && isShortSearchStart(line)) {
			this.blockDelimiterCount = countSearchDelimiter(line)
			throw new DiffError(
				DIFF_ERROR_CODE.DELIMITER_TOO_SHORT,
				renderPrompt("replaceInFile", "diffDelimiterTooShort", { COUNT: String(this.blockDelimiterCount) }),
			)
		}

		if (!this.isSearchingActive() && !this.isReplacingActive() && isSearchBlockStart(line)) {
			this.blockDelimiterCount = countSearchDelimiter(line)
			if (this.blockDelimiterCount < 7) {
				throw new DiffError(
					DIFF_ERROR_CODE.DELIMITER_TOO_SHORT,
					renderPrompt("replaceInFile", "diffDelimiterTooShort", { COUNT: String(this.blockDelimiterCount) }),
				)
			}
			removeLineCount = this.trimPendingNonStandardTrailingEmptyLines(pendingNonStandardLineLimit)
			if (removeLineCount > 0) {
				pendingNonStandardLineLimit = pendingNonStandardLineLimit - removeLineCount
			}
			if (this.hasPendingNonStandardLines(pendingNonStandardLineLimit)) {
				this.tryFixSearchReplaceBlock(pendingNonStandardLineLimit)
				canWritependingNonStandardLines && (this.pendingNonStandardLines.length = 0)
			}
			this.activateSearchState()
		} else if (isSearchBlockEnd(line)) {
			const endCount = countLeadingChar("=", line.trimStart())
			if (endCount !== this.blockDelimiterCount) {
				throw new DiffError(
					DIFF_ERROR_CODE.DELIMITER_MISMATCH,
					renderPrompt("replaceInFile", "diffDelimiterMismatch", {
						SEARCH_N: String(this.blockDelimiterCount),
						CLOSE_N: String(endCount),
					}),
				)
			}
			// 校验非标内容
			if (!this.isSearchingActive()) {
				this.tryFixSearchBlock(pendingNonStandardLineLimit)
				canWritependingNonStandardLines && (this.pendingNonStandardLines.length = 0)
			}
			this.activateReplaceState()
			this.beforeReplace()
		} else if (this.isReplacingActive() && isReplaceBlockEnd(line)) {
			const replaceCount = countLeadingChar("+", line.trimStart())
			if (replaceCount !== this.blockDelimiterCount) {
				throw new DiffError(
					DIFF_ERROR_CODE.DELIMITER_MISMATCH,
					renderPrompt("replaceInFile", "diffDelimiterMismatch", {
						SEARCH_N: String(this.blockDelimiterCount),
						CLOSE_N: String(replaceCount),
					}),
				)
			}
			if (!this.isReplacingActive()) {
				this.tryFixReplaceBlock(pendingNonStandardLineLimit)
				canWritependingNonStandardLines && (this.pendingNonStandardLines.length = 0)
			}
			this.lastProcessedIndex = this.searchEndIndex
			this.resetForNextBlock()
		} else {
			// Accumulate content for search or replace
			// (currentReplaceContent is not being used for anything right now since we directly append to result.)
			// (We artificially add a linebreak since we split on \n at the beginning. In order to not include a trailing linebreak in the final search/result blocks we need to remove it before using them. This allows for partial line matches to be correctly identified.)
			// NOTE: search/replace blocks must be arranged in the order they appear in the file due to how we build the content using lastProcessedIndex. We also cannot strip the trailing newline since for non-partial lines it would remove the linebreak from the original content. (If we remove end linebreak from search, then we'd also have to remove it from replace but we can't know if it's a partial line or not since the model may be using the line break to indicate the end of the block rather than as part of the search content.) We require the model to output full lines in order for our fallbacks to work as well.
			if (this.isReplacingActive()) {
				// Output replacement lines immediately if we know the insertion point
				if (this.searchMatchIndex !== -1) {
					this.result += `${line}\n`
				}
			} else if (this.isSearchingActive()) {
				this.currentSearchContent += `${line}\n`
			} else {
				const appendToPendingNonStandardLines = canWritependingNonStandardLines
				if (appendToPendingNonStandardLines) {
					// 处理非标内容
					this.pendingNonStandardLines.push(line)
				}
			}
		}
		return removeLineCount
	}

	private beforeReplace() {
		// Remove trailing linebreak for adding the === marker
		// if (currentSearchContent.endsWith("\r\n")) {
		// 	currentSearchContent = currentSearchContent.slice(0, -2)
		// } else if (currentSearchContent.endsWith("\n")) {
		// 	currentSearchContent = currentSearchContent.slice(0, -1)
		// }

		if (!this.currentSearchContent) {
			// Empty search block
			if (this.originalContent.length === 0) {
				// New file scenario: nothing to match, just start inserting
				this.searchMatchIndex = 0
				this.searchEndIndex = 0
			} else {
				// Complete file replacement scenario: treat the entire file as matched
				this.searchMatchIndex = 0
				this.searchEndIndex = this.originalContent.length
			}
		} else {
			// Add check for inefficient full-file search
			// if (currentSearchContent.trim() === originalContent.trim()) {
			// 	throw new Error(
			// 		"The SEARCH block contains the entire file content. Please either:\n" +
			// 			"1. Use an empty SEARCH block to replace the entire file, or\n" +
			// 			"2. Make focused changes to specific parts of the file that need modification.",
			// 	)
			// }
			// Exact search match scenario
			const exactIndex = this.originalContent.indexOf(this.currentSearchContent, this.lastProcessedIndex)
			if (exactIndex !== -1) {
				this.searchMatchIndex = exactIndex
				this.searchEndIndex = exactIndex + this.currentSearchContent.length
			} else {
				// Attempt fallback line-trimmed matching
				const lineMatch = lineTrimmedFallbackMatch(
					this.originalContent,
					this.currentSearchContent,
					this.lastProcessedIndex,
				)
				if (lineMatch) {
					;[this.searchMatchIndex, this.searchEndIndex] = lineMatch
				} else {
					// Try block anchor fallback for larger blocks
					const blockMatch = blockAnchorFallbackMatch(
						this.originalContent,
						this.currentSearchContent,
						this.lastProcessedIndex,
					)
					if (blockMatch) {
						;[this.searchMatchIndex, this.searchEndIndex] = blockMatch
					} else {
						throw new DiffError(
							DIFF_ERROR_CODE.SEARCH_NOT_FOUND,
							renderPrompt("replaceInFile", "diffSearchNotFound", {
								LINE_COUNT: formatLineCount(this.currentSearchContent.split("\n").filter((l) => l).length),
							}),
						)
					}
				}
			}
		}
		if (this.searchMatchIndex < this.lastProcessedIndex) {
			throw new DiffError(
				DIFF_ERROR_CODE.BLOCK_OUT_OF_ORDER,
				renderPrompt("replaceInFile", "diffBlockOutOfOrder", { BLOCK_INDEX: "?" }),
			)
		}
		// Output everything up to the match location
		this.result += this.originalContent.slice(this.lastProcessedIndex, this.searchMatchIndex)
	}

	private tryFixSearchBlock(lineLimit: number): number {
		let removeLineCount = 0
		if (lineLimit < 0) {
			lineLimit = this.pendingNonStandardLines.length
		}
		if (!lineLimit) {
			throw new DiffError(DIFF_ERROR_CODE.UNCLOSED_SEARCH, renderPrompt("replaceInFile", "diffUnclosedSearch"))
		}
		const searchTagRegexp = /^([-]{7,}|[<]{7,}) SEARCH$/
		const searchTagIndex = this.findLastMatchingLineIndex(searchTagRegexp, lineLimit)
		if (searchTagIndex !== -1) {
			const fixLines = this.pendingNonStandardLines.slice(searchTagIndex, lineLimit)
			fixLines[0] = SEARCH_BLOCK_START
			for (const line of fixLines) {
				removeLineCount += this.internalProcessLine(line, false, searchTagIndex)
			}
		} else {
			throw new DiffError(DIFF_ERROR_CODE.UNCLOSED_REPLACE, renderPrompt("replaceInFile", "diffUnclosedReplace"))
		}
		return removeLineCount
	}

	private tryFixReplaceBlock(lineLimit: number): number {
		let removeLineCount = 0
		if (lineLimit < 0) {
			lineLimit = this.pendingNonStandardLines.length
		}
		if (!lineLimit) {
			throw new DiffError(DIFF_ERROR_CODE.UNCLOSED_REPLACE, renderPrompt("replaceInFile", "diffUnclosedReplace"))
		}
		const replaceBeginTagRegexp = /^[=]{3,}$/
		const replaceBeginTagIndex = this.findLastMatchingLineIndex(replaceBeginTagRegexp, lineLimit)
		if (replaceBeginTagIndex !== -1) {
			// // 校验非标内容
			// if (!this.isSearchingActive()) {
			// 	removeLineCount += this.tryFixSearchBlock(replaceBeginTagIndex)
			// }
			const fixLines = this.pendingNonStandardLines.slice(
				replaceBeginTagIndex - removeLineCount,
				lineLimit - removeLineCount,
			)
			fixLines[0] = SEARCH_BLOCK_END
			for (const line of fixLines) {
				removeLineCount += this.internalProcessLine(line, false, replaceBeginTagIndex - removeLineCount)
			}
		} else {
			throw new DiffError(DIFF_ERROR_CODE.UNCLOSED_REPLACE, renderPrompt("replaceInFile", "diffUnclosedReplace"))
		}
		return removeLineCount
	}

	private tryFixSearchReplaceBlock(lineLimit: number): number {
		let removeLineCount = 0
		if (lineLimit < 0) {
			lineLimit = this.pendingNonStandardLines.length
		}
		if (!lineLimit) {
			throw new DiffError(DIFF_ERROR_CODE.UNCLOSED_REPLACE, renderPrompt("replaceInFile", "diffUnclosedReplace"))
		}

		const replaceEndTagRegexp = /^([+]{3,}|[>]{3,}) REPLACE$/
		const replaceEndTagIndex = this.findLastMatchingLineIndex(replaceEndTagRegexp, lineLimit)
		const likeReplaceEndTag = replaceEndTagIndex === lineLimit - 1
		if (likeReplaceEndTag) {
			// // 校验非标内容
			// if (!this.isReplacingActive()) {
			// 	removeLineCount += this.tryFixReplaceBlock(replaceEndTagIndex)
			// }
			const fixLines = this.pendingNonStandardLines.slice(replaceEndTagIndex - removeLineCount, lineLimit - removeLineCount)
			fixLines[fixLines.length - 1] = REPLACE_BLOCK_END
			for (const line of fixLines) {
				removeLineCount += this.internalProcessLine(line, false, replaceEndTagIndex - removeLineCount)
			}
		} else {
			throw new Error("Malformed SEARCH/REPLACE block structure: Missing valid closing REPLACE marker")
		}
		return removeLineCount
	}

	/**
	 * Removes trailing empty lines from the pendingNonStandardLines array
	 * @param lineLimit - The index to start checking from (exclusive).
	 *                    Removes empty lines from lineLimit-1 backwards.
	 * @returns The number of empty lines removed
	 */
	private trimPendingNonStandardTrailingEmptyLines(lineLimit: number): number {
		let removedCount = 0
		let i = Math.min(lineLimit, this.pendingNonStandardLines.length) - 1

		while (i >= 0 && this.pendingNonStandardLines[i].trim() === "") {
			this.pendingNonStandardLines.pop()
			removedCount++
			i--
		}

		return removedCount
	}
}

export async function constructNewFileContentV2(
	diffContent: string,
	originalContent: string,
	isFinal: boolean,
): Promise<{ newContent: string; matchIndices: number[]; blocks: DiffBlock[] }> {
	const newFileContentConstructor = new NewFileContentConstructor(originalContent, isFinal)

	const lines = diffContent.split("\n")

	// If the last line looks like a partial marker but isn't recognized,
	// remove it because it might be incomplete.
	const lastLine = lines[lines.length - 1]
	if (
		lines.length > 0 &&
		(lastLine.startsWith(SEARCH_BLOCK_CHAR) ||
			lastLine.startsWith(LEGACY_SEARCH_BLOCK_CHAR) ||
			lastLine.startsWith("=") ||
			lastLine.startsWith(REPLACE_BLOCK_CHAR) ||
			lastLine.startsWith(LEGACY_REPLACE_BLOCK_CHAR)) &&
		!isShortSearchStart(lastLine) &&
		lastLine !== SEARCH_BLOCK_START &&
		lastLine !== SEARCH_BLOCK_END &&
		lastLine !== REPLACE_BLOCK_END
	) {
		lines.pop()
	}

	for (const line of lines) {
		newFileContentConstructor.processLine(line)
	}

	const result = newFileContentConstructor.getResult()
	return result
}

// ─── SKIP ranges and match reporting (DiffParser) ───────────────────────────

export { skipMarkerFor }

const MAX_REPORTED_CANDIDATE_LINES = 10

const MATCH_TIER_LABELS: Record<MatchTier, string> = {
	exact: "exact",
	line_trim: "whitespace-tolerant",
	line_prefix: "line-prefix",
}

function formatCandidateLines(lines: readonly number[]): string {
	const listed = lines.slice(0, MAX_REPORTED_CANDIDATE_LINES).join(", ")
	return lines.length > MAX_REPORTED_CANDIDATE_LINES ? `${listed}, …` : listed
}

/**
 * Render REPLACE lines for a whole-line range, reusing the range's line break
 * style and keeping a missing final newline missing.
 */
function formatReplacement(replaceLines: readonly string[], matchedSource: string): string {
	const lineBreak = matchedSource.includes("\r\n") ? "\r\n" : "\n"
	const replaceText = replaceLines.join(lineBreak)
	if (replaceText === "") return ""
	return matchedSource.endsWith("\n") ? `${replaceText}${lineBreak}` : replaceText
}

type BlockFailure = Required<Pick<ParsedBlock, "errorCode" | "errorMessage">>

type SkipRuleKey = "diffSkipMarkerFirst" | "diffSkipMarkerLast" | "diffSkipMarkerTwice" | "diffSkipMarkerInReplace"

/** Builds a block failure from one replace_in_file prompt template. */
function blockFailure(errorCode: DiffErrorCode, key: string, env: PromptEnv = {}): BlockFailure {
	return { errorCode, errorMessage: renderPrompt("replaceInFile", key, env) }
}

/**
 * Unified DiffParser — processes SEARCH/REPLACE diff line-by-line.
 * Blocks are located with line-aligned, whole-file-unique matching and applied
 * immediately on close; unclosed blocks are reported by finalize().
 */
export class DiffParser {
	private state: "idle" | "search" | "replace" = "idle"
	private delimiterN = 0
	private blockIndex = 0
	private originalContent: string

	private searchLines: string[] = []
	private replaceLines: string[] = []
	private currentRawLines: string[] = []

	private blocks: ParsedBlock[] = []
	private newContent = ""
	private lastProcessedIndex = 0
	private readonly isPartial: boolean
	private readonly lineIndex: FileLineIndex
	private readonly appliedRanges: Array<{ blockNumber: number; range: LineRange }> = []
	/** Index of the SKIP marker within searchLines for the current block. */
	private skipLineIndex: number | undefined

	/** When true, idle-state lines are drained into the previous error block's rawText. */
	private drainToPrevBlock = false

	/**
	 * @param originalContent - Current file content to match against
	 * @param isPartial - When true, finalize() skips UNCLOSED errors
	 *   (normal during streaming — the diff isn't complete yet)
	 */
	constructor(originalContent: string, isPartial = false) {
		this.originalContent = originalContent
		this.isPartial = isPartial
		this.lineIndex = new FileLineIndex(originalContent)
	}

	processLine(line: string): void {
		switch (this.state) {
			case "idle":
				this.handleIdle(line)
				break
			case "search":
				this.handleSearch(line)
				break
			case "replace":
				this.handleReplace(line)
				break
		}
	}

	finalize(): void {
		// In partial mode, skip UNCLOSED errors — the diff is still streaming
		// and an unclosed block is expected, not a real error.
		if (!this.isPartial && (this.state === "search" || this.state === "replace") && this.currentRawLines.length > 0) {
			this.rejectOpenBlock(this.unclosedFailure())
		}
		// Append remaining original content
		if (this.lastProcessedIndex < this.originalContent.length) {
			this.newContent += this.originalContent.slice(this.lastProcessedIndex)
		}
	}

	getResult(): DiffResult {
		return { blocks: this.blocks, newContent: this.newContent }
	}

	// ─── State handlers ──────────────────────────────────────────────

	private handleIdle(line: string): void {
		const trimmed = line.trim()

		// Drain mode: previous block errored, collect stray lines into its rawText
		// so the complete malformed diff block is visible for diagnostics.
		if (this.drainToPrevBlock) {
			const lastBlock = this.blocks[this.blocks.length - 1]
			if (isSearchBlockStart(trimmed)) {
				// Next real block starts — stop draining and handle normally below
				this.drainToPrevBlock = false
			} else if (isReplaceBlockEnd(trimmed)) {
				// Close marker belonging to the errored block — append and stop drain
				if (lastBlock) {
					lastBlock.rawText = lastBlock.rawText ? lastBlock.rawText + "\n" + line : line
				}
				this.drainToPrevBlock = false
				return
			} else {
				// Stray content line between error and close marker — append
				if (lastBlock) {
					lastBlock.rawText = lastBlock.rawText ? lastBlock.rawText + "\n" + line : line
				}
				return
			}
		}

		if (isShortSearchStart(trimmed)) {
			this.delimiterN = countSearchDelimiter(trimmed)
			this.currentRawLines = [line]
			this.rejectOpenBlock(this.delimiterTooShortFailure())
			return
		}

		if (isSearchBlockStart(trimmed)) {
			this.delimiterN = countSearchDelimiter(trimmed)
			if (this.delimiterN < 7) {
				this.rejectOpenBlock(this.delimiterTooShortFailure())
				return
			}
			this.state = "search"
			this.searchLines = []
			this.replaceLines = []
			this.currentRawLines = [line]
			return
		}
		if (isReplaceBlockEnd(trimmed)) {
			this.currentRawLines.push(line)
			this.rejectOpenBlock(blockFailure(DIFF_ERROR_CODE.EXTRA_CLOSE_MARKER, "diffExtraCloseMarker"))
		}
	}

	private handleSearch(line: string): void {
		const trimmed = line.trim()
		this.currentRawLines.push(line)
		if (isSearchBlockEnd(trimmed, this.delimiterN)) {
			// An empty SEARCH is judged when the block closes: a second separator
			// before then proves a content line was read as this one.
			if (this.skipLineIndex !== undefined && this.skipLineIndex === this.searchLines.length - 1) {
				this.rejectOpenBlock(this.skipFailure("diffSkipMarkerLast"))
				return
			}
			this.state = "replace"
			return
		}
		if (isSearchBlockStartExact(trimmed, this.delimiterN)) {
			this.rejectOpenBlock(blockFailure(DIFF_ERROR_CODE.NESTED_SEARCH_MARKER, "diffNestedSearchMarker"))
			return
		}
		// REPLACE end marker in SEARCH block → missing ======= separator
		if (isReplaceBlockEnd(trimmed, this.delimiterN)) {
			const missing = blockFailure(DIFF_ERROR_CODE.MISSING_SEPARATOR, "diffMissingSeparator")
			this.rejectOpenBlock(this.unrecognizedMarkerFailure("SEARCH", missing))
			return
		}
		if (trimmed === skipMarkerFor(this.delimiterN)) {
			// A SKIP range needs a head before it; a second marker is ambiguous.
			if (this.searchLines.length === 0) {
				this.rejectOpenBlock(this.skipFailure("diffSkipMarkerFirst"))
				return
			}
			if (this.skipLineIndex !== undefined) {
				this.rejectOpenBlock(this.skipFailure("diffSkipMarkerTwice"))
				return
			}
			this.skipLineIndex = this.searchLines.length
		}
		this.searchLines.push(line)
	}

	private handleReplace(line: string): void {
		const trimmed = line.trim()
		this.currentRawLines.push(line)
		if (isReplaceBlockEnd(trimmed, this.delimiterN)) {
			this.completeBlock()
			return
		}
		if (isSearchBlockEnd(trimmed, this.delimiterN)) {
			this.replaceLines.push(line)
			this.rejectOpenBlock(this.separatorConflictFailure())
			return
		}
		if (isSearchBlockStartExact(trimmed, this.delimiterN)) {
			this.rejectOpenBlock(blockFailure(DIFF_ERROR_CODE.SEARCH_MARKER_IN_REPLACE, "diffSearchMarkerInReplace"))
			return
		}
		if (trimmed === skipMarkerFor(this.delimiterN)) {
			this.rejectOpenBlock(this.skipFailure("diffSkipMarkerInReplace"))
			return
		}
		this.replaceLines.push(line)
	}

	private completeBlock(): void {
		if (this.searchLines.length === 0) {
			this.rejectClosedBlock(blockFailure(DIFF_ERROR_CODE.EMPTY_SEARCH, "diffEmptySearch"))
			return
		}
		const blockNumber = this.blockIndex + 1
		const match = matchSearchBlock(this.lineIndex, this.searchPattern())
		if (match.kind !== "unique") {
			this.rejectClosedBlock(this.describeMatchFailure(match))
			return
		}
		const conflict = this.findRangeConflict(match.range, blockNumber)
		if (conflict) {
			this.rejectClosedBlock(conflict)
			return
		}
		this.applyReplacement(match.range, blockNumber)
		this.blocks.push({
			...this.blockText(),
			startLine: match.range.startLine,
			endLine: match.range.endLine,
			hasError: false,
			matchedText: this.lineIndex.lineText(match.range),
			matchTier: match.tier,
			skippedLines: match.skippedLines,
		})
		this.resetBlock()
	}

	private searchPattern(): SearchPattern {
		if (this.skipLineIndex === undefined) {
			return { head: this.searchLines }
		}
		return {
			head: this.searchLines.slice(0, this.skipLineIndex),
			tail: this.searchLines.slice(this.skipLineIndex + 1),
		}
	}

	private describeMatchFailure(match: Exclude<SearchMatch, { kind: "unique" }>): BlockFailure {
		if (match.kind === "ambiguous") {
			return {
				errorCode: DIFF_ERROR_CODE.AMBIGUOUS_MATCH,
				errorMessage: renderPrompt("replaceInFile", "diffSearchAmbiguous", {
					MATCH_COUNT: String(match.candidateLines.length),
					MATCH_MODE: MATCH_TIER_LABELS[match.tier],
					LINE_NUMBERS: formatCandidateLines(match.candidateLines),
				}),
			}
		}
		if (match.part === "skip_tail") {
			return blockFailure(DIFF_ERROR_CODE.SEARCH_NOT_FOUND, "diffSkipTailNotFound", { HEAD_LINE: String(match.headLine) })
		}
		const notFound = blockFailure(DIFF_ERROR_CODE.SEARCH_NOT_FOUND, "diffSearchNotFound", {
			LINE_COUNT: formatLineCount(this.searchLines.length),
		})
		const findings = explainSearchNotFound(this.lineIndex, this.searchLines, this.searchPattern().head, this.delimiterN)
		return { ...notFound, errorMessage: withFindings(notFound.errorMessage, findings) }
	}

	/** Blocks must follow file order and never share lines with an applied block. */
	private findRangeConflict(range: LineRange, blockNumber: number): BlockFailure | undefined {
		const overlapped = this.appliedRanges.find(
			(applied) => range.startIndex < applied.range.endIndex && range.endIndex > applied.range.startIndex,
		)
		if (overlapped) {
			return blockFailure(DIFF_ERROR_CODE.BLOCK_OVERLAP, "diffBlockOverlap", {
				BLOCK_INDEX: String(blockNumber),
				PREV_INDEX: String(overlapped.blockNumber),
			})
		}
		if (range.startIndex < this.lastProcessedIndex) {
			return blockFailure(DIFF_ERROR_CODE.BLOCK_OUT_OF_ORDER, "diffBlockOutOfOrder", { BLOCK_INDEX: String(blockNumber) })
		}
		return undefined
	}

	private applyReplacement(range: LineRange, blockNumber: number): void {
		this.newContent += this.originalContent.slice(this.lastProcessedIndex, range.startIndex)
		this.newContent += formatReplacement(this.replaceLines, this.lineIndex.slice(range))
		this.lastProcessedIndex = range.endIndex
		this.appliedRanges.push({ blockNumber, range })
	}

	// ─── Failure construction ────────────────────────────────────────

	private delimiterTooShortFailure(): BlockFailure {
		return blockFailure(DIFF_ERROR_CODE.DELIMITER_TOO_SHORT, "diffDelimiterTooShort", { COUNT: String(this.delimiterN) })
	}

	private skipFailure(rule: SkipRuleKey): BlockFailure {
		return blockFailure(DIFF_ERROR_CODE.INVALID_SKIP_MARKER, rule, { SKIP_MARKER: skipMarkerFor(this.delimiterN) })
	}

	/** A content line equal to the separator: suggest one longer marker set for the whole block. */
	private separatorConflictFailure(): BlockFailure {
		const longer = this.delimiterN + 1
		return blockFailure(DIFF_ERROR_CODE.DELIMITER_CONFLICT, "diffSeparatorConflict", {
			COUNT: String(this.delimiterN),
			SEARCH_MARKER: `${"-".repeat(longer)} SEARCH`,
			SEPARATOR: "=".repeat(longer),
			CLOSE_MARKER: `${"+".repeat(longer)} REPLACE`,
		})
	}

	private unclosedFailure(): BlockFailure {
		if (this.state === "search") {
			return this.unrecognizedMarkerFailure("SEARCH", blockFailure(DIFF_ERROR_CODE.UNCLOSED_SEARCH, "diffUnclosedSearch"))
		}
		return this.unrecognizedMarkerFailure("REPLACE", blockFailure(DIFF_ERROR_CODE.UNCLOSED_REPLACE, "diffUnclosedReplace"))
	}

	/**
	 * Replaces a generic missing-marker failure with the marker-like content line
	 * that explains it. A line of the wrong length is a delimiter mismatch; a
	 * separator with extra text keeps the structural code.
	 *
	 * @param section Section that should have contained the missing marker.
	 * @param fallback Failure reported when no marker-like line explains it.
	 */
	private unrecognizedMarkerFailure(section: BlockSection, fallback: BlockFailure): BlockFailure {
		const lines = section === "SEARCH" ? this.searchLines : this.replaceLines
		const problem = findMarkerProblem(lines, section, this.delimiterN)
		if (!problem) return fallback
		const errorCode = problem.kind === "count_mismatch" ? DIFF_ERROR_CODE.DELIMITER_MISMATCH : fallback.errorCode
		return { errorCode, errorMessage: describeMarkerProblem(problem, this.delimiterN) }
	}

	// ─── Block bookkeeping ───────────────────────────────────────────

	private blockText(): Pick<ParsedBlock, "rawText" | "searchText" | "replaceText"> {
		return {
			rawText: this.currentRawLines.join("\n"),
			searchText: this.searchLines.join("\n"),
			replaceText: this.replaceLines.join("\n"),
		}
	}

	/** Rejects a block whose close marker has been read. */
	private rejectClosedBlock(failure: BlockFailure): void {
		this.blocks.push({ ...this.blockText(), startLine: 0, hasError: true, ...failure })
		this.resetBlock()
	}

	/**
	 * Rejects a block before its close marker. The stray lines up to that marker
	 * still belong to it, so they are drained into its raw text for diagnostics.
	 */
	private rejectOpenBlock(failure: BlockFailure): void {
		this.rejectClosedBlock(failure)
		this.drainToPrevBlock = true
	}

	private resetBlock(): void {
		this.state = "idle"
		this.blockIndex++
		this.skipLineIndex = undefined
		this.searchLines = []
		this.replaceLines = []
		this.currentRawLines = []
	}
}
