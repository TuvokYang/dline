/**
 * Canonical contract for the command-output notice that announces one command's owned
 * full-output log file.
 *
 * The terminal orchestrator formats these notices while streaming command output and the
 * webview turns them into a clickable link, so both sides must resolve the label and the
 * path through this module instead of repeating literal phrases.
 */

/** Label used when a command hands its complete output to an owned log file. */
export const COMMAND_LOG_NOTICE_LABEL = "📋 Output is being logged to:"

const NOTICE_LABEL_SOURCE = [
    "📋 Output is being logged to:",
    "⏱️ Command timed out\\. Output is being logged to:",
    "📋 Output is large \\([^)\\r\\n]*\\)\\. Writing to:",
].join("|")

const NOTICE_PATTERN = new RegExp(`(${NOTICE_LABEL_SOURCE})[ \\t]*([^\\r\\n]*)`)
const NOTICE_LINE_PATTERN = new RegExp(`^(?:${NOTICE_LABEL_SOURCE})`)

/** One log-file notice located inside streamed command output. */
export interface CommandLogNotice {
    /** Log file path announced by the notice. */
    logFilePath: string
    /** Visible label rendered before the path. */
    label: string
    /** Offset where the notice starts inside the searched output. */
    start: number
    /** Offset of the newline ending the notice line, or -1 when the line is unterminated. */
    end: number
}

/** Format the notice emitted when a command's complete output moves to an owned log file. */
export function formatLargeOutputLogNotice(input: { lineCount: number; byteCount: number; logFilePath: string }): string {
    const kilobytes = Math.round(input.byteCount / 1024)
    return `📋 Output is large (${input.lineCount} lines, ${kilobytes}KB). Writing to: ${input.logFilePath}`
}

/** Format the notice emitted when a command keeps logging after a background handoff. */
export function formatCommandLogNotice(logFilePath: string): string {
    return `${COMMAND_LOG_NOTICE_LABEL} ${logFilePath}`
}

/** Locate the first log-file notice in streamed command output. */
export function findCommandLogNotice(output: string): CommandLogNotice | undefined {
    const match = NOTICE_PATTERN.exec(output)
    if (!match) {
        return undefined
    }
    const logFilePath = match[2].trim()
    if (!logFilePath) {
        return undefined
    }
    return {
        logFilePath,
        label: match[1],
        start: match.index,
        end: output.indexOf("\n", match.index),
    }
}

/** Return whether one visible output line only announces the owned log file. */
export function isCommandLogNoticeLine(line: string): boolean {
    return NOTICE_LINE_PATTERN.test(line.trim())
}
