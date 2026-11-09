import type { UiMessage } from "./ExtensionMessage"

/**
 * A command row's three facts, kept apart instead of concatenated into `text`.
 *
 * A command row used to carry everything in one string: the command line, the
 * directory it ran in, and its output, told apart by the markers `Output:` and
 * `REQ_APP`. Every reader had to re-implement that split, so a command whose own
 * text contained a marker read back wrong. The fields below are the authority;
 * `text` keeps only the command line so a row that predates the fields still
 * reads correctly.
 */
export interface CommandRow {
    /** The command line, without the working-directory suffix or the approval marker. */
    readonly command: string
    /** The directory the command ran in, when the row states one. */
    readonly workingDirectory?: string
    /** The command's output; empty when it produced none. */
    readonly output: string
    /** Whether this row asks the user to approve the command. */
    readonly requestsApproval: boolean
}

/** Separates a command line from the directory it runs in, on a legacy row. */
export const WORKING_DIRECTORY_SEPARATOR = "\n\nWorking directory: "

/** Separates a command line from its output, on a legacy row. */
export const COMMAND_OUTPUT_STRING = "Output:"

/** Appended to a command line when the row asks the user to approve it. */
export const COMMAND_REQ_APP_STRING = "REQ_APP"

/**
 * Read a command row, preferring its fields and falling back to its text.
 *
 * A row written before the fields existed states everything in `text`, so the
 * markers are still parsed for it. A row with fields never falls back: its text
 * is the command line alone, and parsing that would misread a command that
 * happens to contain a marker.
 */
export function readCommandRow(
    message: Pick<UiMessage, "text" | "command" | "commandOutput" | "commandWorkingDirectory" | "commandAsksApproval">,
): CommandRow {
    if (message.command !== undefined) {
        return {
            command: message.command,
            workingDirectory: message.commandWorkingDirectory,
            output: message.commandOutput ?? "",
            requestsApproval: message.commandAsksApproval ?? false,
        }
    }
    return parseLegacyCommandText(message.text ?? "")
}

/**
 * Split a legacy command row's text into its three facts.
 *
 * The writers' order is fixed, and it is not the order the fields appear in a
 * sentence: `formatCommandApprovalBody` appends the working directory, and the
 * approval marker goes on after that. So the text ends
 * `<command>\n\nWorking directory: <dir>[REQ_APP][Output:<output>]`. Each suffix
 * is removed from the end in reverse, because the marker is only a marker at the
 * end: a command may legitimately contain the same words, as `echo REQ_APP` does.
 */
function parseLegacyCommandText(text: string): CommandRow {
    // An output follows on its own line, so the command line keeps a trailing
    // newline before it; the suffix markers are only recognizable once that is gone.
    const outputIndex = text.indexOf(COMMAND_OUTPUT_STRING)
    const head = (outputIndex === -1 ? text : text.slice(0, outputIndex)).trimEnd()
    const output = outputIndex === -1 ? "" : text.slice(outputIndex + COMMAND_OUTPUT_STRING.length).trim()

    const requestsApproval = head.endsWith(COMMAND_REQ_APP_STRING)
    const withoutApproval = requestsApproval ? head.slice(0, -COMMAND_REQ_APP_STRING.length) : head

    const directoryIndex = withoutApproval.lastIndexOf(WORKING_DIRECTORY_SEPARATOR)
    if (directoryIndex === -1) {
        return { command: withoutApproval.trim(), output, requestsApproval }
    }
    const workingDirectory = withoutApproval.slice(directoryIndex + WORKING_DIRECTORY_SEPARATOR.length).trim()
    return {
        command: withoutApproval.slice(0, directoryIndex).trimEnd(),
        workingDirectory: workingDirectory === "" ? undefined : workingDirectory,
        output,
        requestsApproval,
    }
}

/**
 * The fields of a command row whose writer still states everything in one string.
 *
 * Only a row written before the fields existed has this shape; a current writer
 * stores the facts directly. This exists so such a row reads correctly, not as a
 * path for new rows.
 */
export function splitCommandRowText(
    text: string | undefined,
): Pick<UiMessage, "command" | "commandOutput" | "commandWorkingDirectory" | "commandAsksApproval"> {
    const row = parseLegacyCommandText(text ?? "")
    return {
        command: row.command,
        commandOutput: row.output,
        commandWorkingDirectory: row.workingDirectory,
        commandAsksApproval: row.requestsApproval,
    }
}

export function writeCommandRowFacts(
    row: CommandRow,
): Pick<UiMessage, "text" | "command" | "commandOutput" | "commandWorkingDirectory" | "commandAsksApproval"> {
    return {
        text: row.command,
        command: row.command,
        commandOutput: row.output,
        commandWorkingDirectory: row.workingDirectory,
        commandAsksApproval: row.requestsApproval,
    }
}
