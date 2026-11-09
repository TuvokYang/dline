import { type CommandRow, readCommandRow } from "./commandRow"
import type { UiMessage } from "./ExtensionMessage"

/**
 * Combines sequences of command and command_output messages in an array of ClineMessages.
 *
 * This function processes an array of ClineMessages objects, looking for sequences
 * where a 'command' message is followed by one or more 'command_output' messages.
 * When such a sequence is found, it combines them into a single message, merging
 * their text contents.
 *
 * @param messages - An array of UiMessage objects to process.
 * @returns A new array of UiMessage objects with command sequences combined.
 *
 * @example
 * const messages: UiMessage[] = [
 *   { type: 'ask', ask: 'command', text: 'ls', ts: 1625097600000 },
 *   { type: 'ask', ask: 'command_output', text: 'file1.txt', ts: 1625097601000 },
 *   { type: 'ask', ask: 'command_output', text: 'file2.txt', ts: 1625097602000 }
 * ];
 * const result = simpleCombineCommandSequences(messages);
 * // Result: [{ type: 'ask', ask: 'command', text: 'ls\nfile1.txt\nfile2.txt', ts: 1625097600000 }]
 */
export function combineCommandSequences(messages: UiMessage[]): UiMessage[] {
    // Map from command ts to accumulated output text
    const outputByCmdTs = new Map<number, string>()
    // Track ts of command_output messages that were successfully merged
    const mergedOutputTs = new Set<number>()

    // For each command_output, use the explicit commandTs association (set by CommandOrchestrator)
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i]
        if (msg.ask === "command_output" || msg.say === "command_output") {
            const targetCmdTs = msg.commandTs
            if (targetCmdTs && targetCmdTs > 0) {
                mergedOutputTs.add(msg.ts)
                const existing = outputByCmdTs.get(targetCmdTs) || ""
                const output = msg.text || ""
                if (output.length > 0) {
                    outputByCmdTs.set(targetCmdTs, existing ? `${existing}\n${output}` : output)
                } else if (!existing) {
                    outputByCmdTs.set(targetCmdTs, "")
                }
            }
        }
    }

    // Build combined command messages
    const combinedCommands = new Map<number, UiMessage>()
    for (const msg of messages) {
        if (msg.ask === "command" || msg.say === "command") {
            const output = outputByCmdTs.get(msg.ts)
            if (output !== undefined) {
                // The output is its own fact, so it is merged into the field rather
                // than appended to the command line a reader would have to split.
                const row = readCommandRow(msg)
                combinedCommands.set(msg.ts, { ...msg, ...writeOutput(row, output) })
            } else {
                combinedCommands.set(msg.ts, { ...msg })
            }
        }
    }

    // Remove all command_output messages. With block.ts-based commandTs,
    // all outputs are correctly associated and merged into their command.
    return messages
        .filter((msg) => msg.ask !== "command_output" && msg.say !== "command_output")
        .map((msg) => {
            if (msg.ask === "command" || msg.say === "command") {
                const combinedCommand = combinedCommands.get(msg.ts)
                return combinedCommand || msg
            }
            return msg
        })
}
export { COMMAND_OUTPUT_STRING, COMMAND_REQ_APP_STRING } from "./commandRow"

/**
 * A command row with its output attached.
 *
 * The row keeps its command line, directory and approval state; only the output
 * changes, and it changes in the field that owns it. A legacy row that stated
 * everything in one string still reads correctly because the split happens here.
 */
function writeOutput(row: CommandRow, output: string): Partial<UiMessage> {
    // A row may already carry output in its own text; the arriving output is
    // appended to it rather than replacing it, so a mixed row loses nothing.
    const merged = row.output.length === 0 ? output : output.length === 0 ? row.output : `${row.output}\n${output}`
    return {
        command: row.command,
        commandWorkingDirectory: row.workingDirectory,
        commandOutput: merged,
        commandAsksApproval: row.requestsApproval,
    }
}
