import { boundToolText, TOOL_RESULT_SELF_BOUND_BYTES } from "@shared/content-limits"
import type { ClineToolResponseContent } from "@shared/messages"

const FULL_OUTPUT_LOG_PREFIX = "Full output saved to:"
/** Longest output line kept whole once the output no longer fits its budget. */
const MAX_OUTPUT_LINE_BYTES = 2 * 1024

export interface CommandResultParts {
    /** How the command ended, or that it is still running. */
    readonly status: string
    readonly output: string
    /** Line introducing the output; dropped when there is no output. */
    readonly outputLabel?: string
    readonly logFilePath?: string
    /** Guidance after the log path, such as how a running command is followed. */
    readonly footer?: string
    /** Byte budget of the whole result; the self-bound cap when the call has no context budget. */
    readonly maxBytes?: number
}

/**
 * Compose the model-visible result of one command within its byte budget.
 *
 * The status, the full-output log path, and the footer always survive; only
 * the output is cut, and it keeps both ends because a failing command usually
 * reports its error last. The log path stays the last line before the footer,
 * where readers of earlier results already look for it.
 */
export function formatCommandResult(parts: CommandResultParts): string {
    const header = parts.output && parts.outputLabel ? `${parts.status}\n${parts.outputLabel}` : parts.status
    const logLine = parts.logFilePath ? `${FULL_OUTPUT_LOG_PREFIX} ${parts.logFilePath}` : ""
    const trailer = [logLine, parts.footer ?? ""].filter((part) => part.length > 0).join("\n")
    return boundToolText(
        { header, body: parts.output, trailer },
        {
            strategy: "headTail",
            maxBytes: Math.min(parts.maxBytes ?? TOOL_RESULT_SELF_BOUND_BYTES, TOOL_RESULT_SELF_BOUND_BYTES),
            maxLineBytes: MAX_OUTPUT_LINE_BYTES,
            hint: parts.logFilePath
                ? "the full output log below has every line"
                : "rerun with narrower output to see the omitted lines",
        },
    )
}

function contentIncludesLogPath(content: ClineToolResponseContent, logFilePath: string): boolean {
    const textBlocks =
        typeof content === "string" ? [content] : content.flatMap((block) => (block.type === "text" ? [block.text] : []))
    return textBlocks.some((text) => text.split(/\r?\n/).some((line) => line.trim().endsWith(logFilePath)))
}

/** Append one model-visible log path line when the result does not already expose the same path. */
export function appendCommandLogPath(
    content: ClineToolResponseContent,
    logFilePath: string | undefined,
): ClineToolResponseContent {
    if (!logFilePath || contentIncludesLogPath(content, logFilePath)) {
        return content
    }

    const logLine = `${FULL_OUTPUT_LOG_PREFIX} ${logFilePath}`
    if (typeof content === "string") {
        return content.length > 0 ? `${content}\n${logLine}` : logLine
    }

    return [...content, { type: "text", text: logLine }]
}
