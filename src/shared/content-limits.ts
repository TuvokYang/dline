/** Content size limits that keep file extraction and canonical tool results bounded. */

/** Maximum raw extracted content size in bytes (400KB). */
export const MAX_CONTENT_SIZE_BYTES = 400 * 1024

/** Maximum text contributed by one canonical tool result (64KB). */
export const MAX_TOOL_RESULT_TEXT_BYTES = 64 * 1024

/** Room a tool leaves for the description its result is sent under. */
const TOOL_RESULT_FRAME_RESERVE_BYTES = 2 * 1024
/**
 * Budget for a tool that bounds its own result with a tool-specific strategy,
 * so the final canonical bound never cuts that result a second time.
 */
export const TOOL_RESULT_SELF_BOUND_BYTES = MAX_TOOL_RESULT_TEXT_BYTES - TOOL_RESULT_FRAME_RESERVE_BYTES

/**
 * Format bytes into a human-readable string (e.g., "1.5 MB", "400 KB").
 */
export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`
    }
    if (bytes < 1024 * 1024) {
        return `${(bytes / 1024).toFixed(1)} KB`
    }
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Truncate content if it exceeds the maximum size limit.
 * Shows the beginning of the content with a clear truncation notice at the very end.
 *
 * @param content The content to potentially truncate
 * @param maxSize Maximum size in bytes (defaults to MAX_CONTENT_SIZE_BYTES)
 * @returns The original content if under limit, or truncated content with message at end
 */
export function truncateContent(content: string, maxSize: number = MAX_CONTENT_SIZE_BYTES): string {
    const normalizedMaxSize = Math.max(0, Math.floor(maxSize))
    const contentBytes = Buffer.byteLength(content, "utf8")
    if (contentBytes <= normalizedMaxSize) {
        return content
    }
    if (normalizedMaxSize === 0) {
        return ""
    }

    const marker = `${TRUNCATION_MARKER_PREFIX} showed the first part of ${formatBytes(contentBytes)}; the limit is ${formatBytes(normalizedMaxSize)}.]`
    const markerBytes = Buffer.byteLength(marker, "utf8")
    if (markerBytes >= normalizedMaxSize) {
        return sliceUtf8ToByteLimit(marker, normalizedMaxSize)
    }

    const body = sliceUtf8ToByteLimit(content, normalizedMaxSize - markerBytes)
    return `${body}${marker}`
}

/**
 * Opening of every notice a cut result carries, whichever function cut it.
 * Neutral on purpose: the same notice marks file extracts, command output, and
 * any other tool result, so one search finds every cut.
 */
export const TRUNCATION_NOTICE = "[OUTPUT TRUNCATED:"

/** The notice `truncateContent` appends, set off from the kept content by a rule. */
export const TRUNCATION_MARKER_PREFIX = `\n\n---\n\n${TRUNCATION_NOTICE}`

/** The widest size `formatBytes` renders below 1 MB, which a kept part may reach. */
const WIDEST_SUB_MEGABYTE_LABEL = "1024.0 KB"

/** How the body of a tool result is cut when it does not fit. */
export type ToolTextTruncation = "head" | "lines" | "headTail"

/** A tool result split into the parts that must survive and the part that may be cut. */
export interface ToolTextParts {
    /** Status, identity, or paths the model needs to act on the result; always kept. */
    readonly header?: string
    readonly body: string
    /** Continuation hints or exit status; always kept. */
    readonly trailer?: string
}

export interface BoundToolTextOptions {
    readonly strategy: ToolTextTruncation
    readonly maxBytes?: number
    /** Tool-specific next step appended to the truncation notice. */
    readonly hint?: string
    /**
     * Once the body does not fit, cut each longer line to this many bytes first,
     * so a few huge lines cannot crowd every other line out of the result.
     */
    readonly maxLineBytes?: number
}

/** Each kept frame part is capped so a runaway header cannot crowd out the body. */
const MAX_FRAME_PART_BYTES = 4 * 1024
/** Share of the body budget given to the head when both ends are kept; errors usually sit at the end. */
const HEAD_SHARE = 0.4

/**
 * Fit a tool result into its byte budget while keeping its header and trailer.
 *
 * Only the body is cut: `head` keeps the beginning, `lines` keeps whole leading
 * lines, and `headTail` keeps whole lines from both ends around the notice.
 */
export function boundToolText(parts: ToolTextParts, options: BoundToolTextOptions): string {
    const maxBytes = Math.max(0, Math.floor(options.maxBytes ?? MAX_TOOL_RESULT_TEXT_BYTES))
    const header = parts.header ? sliceUtf8ToByteLimit(parts.header, MAX_FRAME_PART_BYTES) : ""
    const trailer = parts.trailer ? sliceUtf8ToByteLimit(parts.trailer, MAX_FRAME_PART_BYTES) : ""
    const whole = joinParts([header, parts.body, trailer])
    if (byteLength(whole) <= maxBytes) return whole

    const bodyBytes = byteLength(parts.body)
    const body = options.maxLineBytes ? capLongLines(parts.body, options.maxLineBytes) : parts.body
    const withCappedLines = joinParts([header, body, trailer])
    if (byteLength(withCappedLines) <= maxBytes) return withCappedLines

    const noticeWith = (keptLabel: string) =>
        `${TRUNCATION_NOTICE} showed ${keptLabel} of ${formatBytes(bodyBytes)}${options.hint ? `; ${options.hint}` : ""}]`
    const notice = (keptBytes: number) => noticeWith(formatBytes(keptBytes))
    // Sized with the widest label the kept part can get, so the final notice
    // never pushes the result past the budget: 999.5 KB kept of 1.0 MB is wider.
    const bodyLabel = formatBytes(bodyBytes)
    const widestLabel = bodyLabel.length >= WIDEST_SUB_MEGABYTE_LABEL.length ? bodyLabel : WIDEST_SUB_MEGABYTE_LABEL
    const frameBytes = byteLength(joinParts([header, noticeWith(widestLabel), trailer])) + 2
    const bodyBudget = maxBytes - frameBytes
    if (bodyBudget <= 0) return fitFrame(header, notice(0), trailer, maxBytes)

    if (options.strategy === "headTail") {
        const head = keepWholeLines(sliceUtf8ToByteLimit(body, Math.floor(bodyBudget * HEAD_SHARE)))
        const tail = keepWholeTailLines(sliceUtf8FromEnd(body, bodyBudget - byteLength(head)))
        return joinParts([header, head, notice(byteLength(head) + byteLength(tail)), tail, trailer])
    }
    const sliced = sliceUtf8ToByteLimit(body, bodyBudget)
    const kept = options.strategy === "lines" ? keepWholeLines(sliced) : sliced
    return joinParts([header, kept, notice(byteLength(kept)), trailer])
}

/**
 * Fit the frame alone when no body fits. The trailer - exit status, the log
 * path - matters most, so the header gives way first, then the notice.
 */
function fitFrame(header: string, notice: string, trailer: string, maxBytes: number): string {
    const tail = joinParts([notice, trailer])
    const headerRoom = maxBytes - byteLength(tail) - 1
    if (headerRoom > 0) return joinParts([sliceUtf8ToByteLimit(header, headerRoom), tail])
    return sliceUtf8FromEnd(tail, maxBytes)
}

/** Cut every line longer than `maxLineBytes`, saying how much of it was left out. */
function capLongLines(text: string, maxLineBytes: number): string {
    return text
        .split("\n")
        .map((line) => {
            const lineBytes = byteLength(line)
            if (lineBytes <= maxLineBytes) return line
            const kept = sliceUtf8ToByteLimit(line, maxLineBytes)
            return `${kept}… [line cut: ${formatBytes(lineBytes - byteLength(kept))} omitted]`
        })
        .join("\n")
}

function joinParts(parts: readonly string[]): string {
    return parts.filter((part) => part.length > 0).join("\n")
}

function byteLength(text: string): number {
    return Buffer.byteLength(text, "utf8")
}

/**
 * Drop a trailing partial line. A cut line longer than the rest is kept instead,
 * so one huge line - minified code, a JSON blob - does not empty the slice.
 */
function keepWholeLines(text: string): string {
    const lastBreak = text.lastIndexOf("\n")
    return lastBreak >= text.length / 2 ? text.slice(0, lastBreak) : text
}

/** Drop a leading partial line, with the same huge-line exception as keepWholeLines. */
function keepWholeTailLines(text: string): string {
    const firstBreak = text.indexOf("\n")
    return firstBreak >= 0 && firstBreak < text.length / 2 ? text.slice(firstBreak + 1) : text
}

function sliceUtf8FromEnd(content: string, maxBytes: number): string {
    if (maxBytes <= 0) return ""
    let low = 0
    let high = content.length
    let best = content.length
    while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        if (Buffer.byteLength(content.slice(middle), "utf8") <= maxBytes) {
            best = middle
            high = middle - 1
        } else {
            low = middle + 1
        }
    }
    if (best < content.length && /[\uDC00-\uDFFF]/.test(content.charAt(best))) best++
    return content.slice(best)
}

function sliceUtf8ToByteLimit(content: string, maxBytes: number): string {
    let low = 0
    let high = content.length
    let best = 0
    while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const candidate = content.slice(0, middle)
        if (Buffer.byteLength(candidate, "utf8") <= maxBytes) {
            best = middle
            low = middle + 1
        } else {
            high = middle - 1
        }
    }
    if (best > 0 && /[\uD800-\uDBFF]/.test(content.charAt(best - 1))) {
        best--
    }
    return content.slice(0, best)
}
