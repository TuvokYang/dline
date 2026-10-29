import type { UiAsk, UiMessage } from "@shared/ExtensionMessage"

/** What separates a command approval's command line from the directory it runs in. */
const WORKING_DIRECTORY_SEPARATOR = "\n\nWorking directory: "

/** The body of a command approval: the command line, then the directory it runs in. */
export function formatCommandApprovalBody(commandLine: string, workingDirectory: string): string {
    return `${commandLine}${WORKING_DIRECTORY_SEPARATOR}${workingDirectory}`
}

/**
 * Build the canonical complete ask row every writer of an ask must use.
 *
 * A command ask starts `pending`: the chat treats a settled command row with
 * no status as a finished legacy command and collapses its card for good, so
 * an ask written without one would hide every later state - running,
 * cancelled, interrupted - behind the one-line summary.
 */
export function createCanonicalAskRow(type: UiAsk, text: string | undefined, ts: number, interactionId?: string): UiMessage {
    const commandPresentation = type === "command" ? { commandStatus: "pending" as const, exitCode: undefined } : {}
    const interactionIdentity = interactionId ? { interactionId } : {}
    return {
        ts,
        type: "ask",
        say: undefined,
        ask: type,
        text,
        partial: false,
        ...interactionIdentity,
        ...commandPresentation,
    }
}
