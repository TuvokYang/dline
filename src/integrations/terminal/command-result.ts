import type { ClineToolResponseContent } from "@shared/messages"

const FULL_OUTPUT_LOG_PREFIX = "Full output saved to:"

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
