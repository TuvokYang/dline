import { writeCommandRowFacts } from "@shared/commandRow"
import type { UiAsk, UiMessage } from "@shared/ExtensionMessage"

/** A command approval's facts, before they are turned into a row. */
export interface CommandApprovalBody {
    /** The command line exactly as it will run; never a decorated string. */
    readonly commandLine: string
    /** The directory the command runs in. */
    readonly workingDirectory: string
}

/**
 * A command approval's facts.
 *
 * The directory used to be appended to the command line, so every reader had to
 * split the two apart again. Keeping them separate means a command that contains
 * a marker is stored as the command it is.
 */
export function commandApprovalBody(commandLine: string, workingDirectory: string): CommandApprovalBody {
    return { commandLine, workingDirectory }
}

/**
 * Build the canonical complete ask row every writer of an ask must use.
 *
 * A command ask starts `pending`: the chat treats a settled command row with
 * no status as a finished legacy command and collapses its card for good, so
 * an ask written without one would hide every later state - running,
 * cancelled, interrupted - behind the one-line summary.
 */
export function createCanonicalAskRow(
    type: UiAsk,
    text: string | undefined,
    ts: number,
    interactionId?: string,
    command?: CommandApprovalBody,
): UiMessage {
    const commandPresentation = type === "command" ? { commandStatus: "pending" as const, exitCode: undefined } : {}
    const interactionIdentity = interactionId ? { interactionId } : {}
    // A command ask states its facts as fields; its text stays the command line
    // so a reader that predates the fields still shows what will run.
    const commandFacts = command
        ? writeCommandRowFacts({
              command: command.commandLine,
              workingDirectory: command.workingDirectory,
              output: "",
              requestsApproval: true,
          })
        : {}
    return {
        ts,
        type: "ask",
        say: undefined,
        ask: type,
        text: command ? command.commandLine : text,
        partial: false,
        ...interactionIdentity,
        ...commandPresentation,
        ...commandFacts,
    }
}
