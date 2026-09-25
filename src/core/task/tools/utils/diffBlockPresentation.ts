import type { ParsedBlock } from "@core/assistant-message/diff"

/**
 * Presentation of parsed replace_in_file blocks.
 *
 * The streaming card, the final card, the failure card and the tool result sent
 * to the model all derive from the same ParsedBlock list. SEARCH lines may be
 * line prefixes and a SKIP range covers lines the model never wrote, so "the
 * lines a block replaces" is the matched file text, not the SEARCH text. This
 * module is the single definition of that projection.
 */

/** Webview card fields derived from parsed blocks. */
export interface DiffCardProjection {
	content: string[]
	startLineNumbers: number[]
	blockErrors: (string | undefined)[]
}

/** Deleted and added line totals across the applied blocks. */
export interface DiffLineCounts {
	deletedLines: number
	addedLines: number
}

const GENERIC_DIFF_ERROR = "SEARCH/REPLACE error"

/**
 * Diff errors that a partially received SEARCH/REPLACE block can prove.
 *
 * Every other code depends on content the stream has not delivered yet, so
 * reporting it mid-stream produces an error that a later chunk withdraws.
 */
const STREAMING_CONCLUSIVE_ERRORS: ReadonlySet<string> = new Set([
	"DELIMITER_TOO_SHORT",
	"DELIMITER_MISMATCH",
	"DELIMITER_CONFLICT",
	"INVALID_SKIP_MARKER",
])

const BRIEF_DIFF_ERRORS: Readonly<Record<string, string>> = {
	DELIMITER_TOO_SHORT: "Delimiter count below minimum",
	DELIMITER_MISMATCH: "Delimiter count mismatch",
	DELIMITER_CONFLICT: "Delimiter conflict",
	SEARCH_NOT_FOUND: "SEARCH not found in file",
	AMBIGUOUS_MATCH: "SEARCH matches multiple locations",
	INVALID_SKIP_MARKER: "Invalid SKIP marker",
	EMPTY_SEARCH_CONTENT_CONFLICT: "Empty SEARCH block",
	UNCLOSED_SEARCH: "Unclosed SEARCH block",
	UNCLOSED_REPLACE: "Unclosed REPLACE block",
	BLOCK_OVERLAP: "Block overlap",
	BLOCK_OUT_OF_ORDER: "Block out of order",
	EXTRA_CLOSE_MARKER: "Unexpected close marker",
	NESTED_SEARCH_MARKER: "Nested SEARCH marker",
	MISSING_SEPARATOR: "Missing separator",
	SEARCH_MARKER_IN_REPLACE: "SEARCH marker in REPLACE",
	FINAL_VALIDATION: "Final validation failed",
}

/**
 * Map a DIFF_ERROR_CODE to the one-line message shown on the webview card.
 *
 * @param code Error code of a failed block, if the parser assigned one.
 * @returns Brief message, or a generic one for unknown codes.
 */
export function briefDiffError(code: string | undefined): string {
	return (code && BRIEF_DIFF_ERRORS[code]) || GENERIC_DIFF_ERROR
}

/**
 * Project one block into the "- old / + new" lines the webview colours.
 *
 * The removed side is the matched file text when the block matched, so a
 * line-prefix SEARCH or a SKIP range shows every line that is actually replaced.
 * Before a match exists the SEARCH text is the best available preview.
 *
 * @param block Parsed block with or without a match.
 * @returns Webview line projection for the block.
 */
export function projectBlockLines(block: ParsedBlock): string {
	const removed = block.matchedText ?? block.searchText
	return `- ${removed.replace(/\n/g, "\n- ")}\n+ ${block.replaceText.replace(/\n/g, "\n+ ")}`
}

/**
 * Project a completed diff for the final or failure card.
 *
 * @param blocks Blocks of a fully received diff.
 * @returns Card fields; failed blocks keep their raw text for inspection.
 */
export function projectFinalCard(blocks: readonly ParsedBlock[]): DiffCardProjection {
	const visible = blocks.filter((block) => !block.hasError || block.rawText.trim())
	return {
		content: visible.map((block) => (block.hasError ? block.rawText : projectBlockLines(block))),
		startLineNumbers: visible.map((block) => block.startLine),
		blockErrors: visible.map((block) => (block.hasError ? briefDiffError(block.errorCode) : undefined)),
	}
}

/**
 * Project an in-flight diff for the streaming card.
 *
 * Only conclusive syntax errors fall back to raw text. Every other block is
 * projected optimistically so a block that has not matched yet does not flip
 * between projected and raw output on consecutive chunks, which the webview
 * renders as the diff card collapsing and expanding.
 *
 * @param blocks Blocks parsed from a partially received diff.
 * @returns Card fields for the streaming say message.
 */
export function projectStreamingCard(blocks: readonly ParsedBlock[]): DiffCardProjection {
	const visible = blocks.filter((block) => !isConclusiveStreamingError(block) || block.rawText.trim())
	return {
		content: visible.map((block) => (isConclusiveStreamingError(block) ? block.rawText : projectBlockLines(block))),
		startLineNumbers: visible.map((block) => block.startLine),
		blockErrors: visible.map((block) => (isConclusiveStreamingError(block) ? briefDiffError(block.errorCode) : undefined)),
	}
}

/**
 * Sum the deleted and added lines of the applied blocks.
 *
 * @param blocks Parsed blocks; failed blocks changed nothing and count as zero.
 * @returns Line totals for the tool result.
 */
export function countAppliedLines(blocks: readonly ParsedBlock[]): DiffLineCounts {
	let deletedLines = 0
	let addedLines = 0
	for (const block of blocks) {
		if (block.hasError) continue
		deletedLines += deletedLineCount(block)
		addedLines += addedLineCount(block)
	}
	return { deletedLines, addedLines }
}

/**
 * Describe the outcome of every block for the tool result sent to the model.
 *
 * Successful blocks report the original line range they replaced so the model
 * can confirm that a line-prefix SEARCH or a SKIP range covered what it meant.
 *
 * @param blocks Parsed blocks in diff order.
 * @returns One line per block, prefixed with the block number when there are several.
 */
export function describeBlockOutcomes(blocks: readonly ParsedBlock[]): string {
	return blocks
		.map((block, index) => {
			const prefix = blocks.length > 1 ? `Block #${index + 1}: ` : ""
			return `${prefix}${describeBlockOutcome(block)}`
		})
		.join("\n")
}

function describeBlockOutcome(block: ParsedBlock): string {
	if (block.hasError) {
		return `error — ${block.errorMessage ?? GENERIC_DIFF_ERROR}`
	}
	const counts = `deleted ${deletedLineCount(block)} lines, added ${addedLineCount(block)} lines`
	if (block.endLine === undefined) {
		return `success — ${counts}.`
	}
	const skipped = block.skippedLines ? `, including ${block.skippedLines} lines inside the SKIP range` : ""
	return `success — replaced original lines ${block.startLine}-${block.endLine}${skipped} (${counts}).`
}

function deletedLineCount(block: ParsedBlock): number {
	if (block.endLine !== undefined && block.startLine > 0) {
		return block.endLine - block.startLine + 1
	}
	return block.searchText ? block.searchText.split("\n").length : 0
}

function addedLineCount(block: ParsedBlock): number {
	return block.replaceText ? block.replaceText.split("\n").length : 0
}

function isConclusiveStreamingError(block: ParsedBlock): boolean {
	return block.hasError && !!block.errorCode && STREAMING_CONCLUSIVE_ERRORS.has(block.errorCode)
}
