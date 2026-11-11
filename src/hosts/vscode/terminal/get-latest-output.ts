import { readTextFromClipboard, writeTextToClipboard } from "@utils/env"
import * as vscode from "vscode"

export interface LatestTerminalOutputOptions {
    /** Command capture does not select the terminal or move the user's keyboard focus. */
    scope?: "buffer" | "command"
    /** Keep the final terminal line so callers can inspect a completion marker. */
    preserveLastLine?: boolean
    /** Refuse to capture another terminal after focus changes. */
    terminal?: vscode.Terminal
    /**
     * Return every captured line instead of cropping to the latest prompt. A completion marker
     * can sit above prompts printed after the command, and cropping would discard it.
     */
    wholeBuffer?: boolean
}

let terminalCaptureTail: Promise<void> = Promise.resolve()

/**
 * Gets the contents of the active terminal
 * @returns The terminal contents as a string
 */
export function getLatestTerminalOutput(options: LatestTerminalOutputOptions = {}): Promise<string> {
    const capture = terminalCaptureTail.then(() => captureLatestTerminalOutput(options))
    terminalCaptureTail = capture.then(
        () => undefined,
        () => undefined,
    )
    return capture
}

async function captureLatestTerminalOutput(options: LatestTerminalOutputOptions): Promise<string> {
    if (options.terminal && vscode.window.activeTerminal !== options.terminal) return ""

    // Store original clipboard content to restore later
    const originalClipboard = await readTextFromClipboard()
    let capturedClipboard: string | undefined

    try {
        if (options.scope === "command") {
            await vscode.commands.executeCommand("workbench.action.terminal.copyLastCommandOutput")
        } else {
            // Explicit buffer references retain the complete scrollback selection.
            await vscode.commands.executeCommand("workbench.action.terminal.selectAll")
            await vscode.commands.executeCommand("workbench.action.terminal.copySelection")
            await vscode.commands.executeCommand("workbench.action.terminal.clearSelection")
        }

        // Get terminal contents from clipboard
        capturedClipboard = await readTextFromClipboard()
        if (options.terminal && vscode.window.activeTerminal !== options.terminal) return ""
        let terminalContents = capturedClipboard.trim()

        // Check if there's actually a terminal open
        if (terminalContents === originalClipboard) {
            return ""
        }

        // Command output has no trailing shell prompt to remove.
        if (options.scope === "command") return terminalContents

        // Clean up command separation
        const lines = terminalContents.split("\n")
        const lastLine = lines.pop()?.trim()
        if (lastLine && !options.wholeBuffer) {
            let i = lines.length - 1
            while (i >= 0 && !lines[i].trim().startsWith(lastLine)) {
                i--
            }
            const currentCommandLines = lines.slice(Math.max(i, 0))
            terminalContents = options.preserveLastLine
                ? [...currentCommandLines, lastLine].join("\n")
                : currentCommandLines.join("\n")
        }

        return terminalContents
    } finally {
        // Do not overwrite content the user copied while capture was in flight.
        if (capturedClipboard !== undefined && (await readTextFromClipboard()) === capturedClipboard) {
            await writeTextToClipboard(originalClipboard)
        }
    }
}
