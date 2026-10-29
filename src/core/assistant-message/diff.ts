import { renderPrompt } from "@core/prompts/i18n"
import type { PromptEnv } from "@core/prompts/template/types"
import { normalizeLineEndings } from "@/shared/string"
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
 * Result from the unified diff parser (DiffParser).
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
 * Shared by DiffParser (API result) and StreamingDiffParser (webview).
 * All values use UPPER_CASE for consistency across modules.
 */
export const DIFF_ERROR_CODE = {
    // Common: DiffParser + StreamingDiffParser
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
 * Structured SEARCH/REPLACE parsing failure.
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
const LEGACY_SEARCH_BLOCK_CHAR = "<"

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

/** Render REPLACE lines with LF while keeping a missing final newline missing. */
function formatReplacement(replaceLines: readonly string[], matchedSource: string): string {
    const replaceText = replaceLines.join("\n")
    if (replaceText === "") return ""
    return matchedSource.endsWith("\n") ? `${replaceText}\n` : replaceText
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
        this.originalContent = normalizeLineEndings(originalContent)
        this.isPartial = isPartial
        this.lineIndex = new FileLineIndex(this.originalContent)
    }

    processLine(line: string): void {
        line = line.endsWith("\r") ? line.slice(0, -1) : line
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
            const promptKey = match.part === "skip_tail" ? "diffSkipTailAmbiguous" : "diffSearchAmbiguous"
            const commonEnv: PromptEnv = {
                MATCH_COUNT: String(match.candidateLines.length),
                MATCH_MODE: MATCH_TIER_LABELS[match.tier],
                LINE_NUMBERS: formatCandidateLines(match.candidateLines),
            }
            const env: PromptEnv = match.part === "skip_tail" ? { ...commonEnv, HEAD_LINE: String(match.headLine) } : commonEnv
            return {
                errorCode: DIFF_ERROR_CODE.AMBIGUOUS_MATCH,
                errorMessage: renderPrompt("replaceInFile", promptKey, env),
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
