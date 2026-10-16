import { UiMessage } from "./ExtensionMessage"

type HookStatusSay = "hook" | "hook_status"
type HookOutputStreamSay = "hook_output" | "hook_output_stream"

function getSay(msg: UiMessage): string | undefined {
    // Back-compat: older recordings may be deserialized without strict typing.
    return msg.say as string | undefined
}

function isHookStatusSay(say: string | undefined): say is HookStatusSay {
    return say === "hook_status" || say === "hook"
}

function isHookOutputStreamSay(say: string | undefined): say is HookOutputStreamSay {
    return say === "hook_output_stream" || say === "hook_output"
}

// ============================================================================
// PART 1: TYPE GUARDS & UTILITIES
// ============================================================================

/**
 * Type guard to check if a message is a tool or command.
 */
function isToolOrCommandMessage(msg: UiMessage): boolean {
    return msg.ask === "tool" || msg.say === "tool" || msg.ask === "command" || msg.say === "command"
}

// ============================================================================
// PART 2: FILTERING & COMBINING
// ============================================================================

/**
 * Deduplicates tool/command messages by timestamp while preserving all
 * non-tool messages and the newest tool/command version for each timestamp.
 *
 * This preserves streaming partial tool rows in the UI while still preventing
 * duplicate tool/command entries when both partial and final variants exist.
 */
function dedupeToolOrCommandMessagesByTimestamp(messages: UiMessage[]): UiMessage[] {
    const lastToolOrCommandIndexByTs = new Map<number, number>()

    for (let i = 0; i < messages.length; i++) {
        if (isToolOrCommandMessage(messages[i])) {
            lastToolOrCommandIndexByTs.set(messages[i].ts, i)
        }
    }

    return messages.filter((msg, index) => {
        if (!isToolOrCommandMessage(msg)) {
            return true
        }
        return lastToolOrCommandIndexByTs.get(msg.ts) === index
    })
}

/**
 * Combines a single hook message with all subsequent hook_output messages.
 *
 * @param hookMessage The hook message to start combining from
 * @param startIndex The index of the hook message in the messages array
 * @param messages The full messages array
 * @returns Object containing the combined message and the next index to process
 */
function combineHookWithOutputs(
    hookMessage: UiMessage,
    startIndex: number,
    messages: UiMessage[],
): { combined: UiMessage; nextIndex: number } {
    let combinedText = hookMessage.text || ""
    let hasOutput = false
    let i = startIndex + 1

    // Collect all hook_output_stream messages until we hit another hook_status/hook or end of array
    while (i < messages.length && !isHookStatusSay(getSay(messages[i]))) {
        const say = getSay(messages[i])
        if (isHookOutputStreamSay(say)) {
            // Add marker before first output
            if (!hasOutput) {
                combinedText += `\n${HOOK_OUTPUT_STRING}`
                hasOutput = true
            }

            // Append output if not empty
            const output = messages[i].text || ""
            if (output.length > 0) {
                combinedText += `\n${output}`
            }
        }
        i++
    }

    return {
        combined: { ...hookMessage, text: combinedText },
        nextIndex: i,
    }
}

/**
 * Combines all hooks with their outputs and removes hook_output messages.
 *
 * This is a two-pass process:
 * 1. Scan through and combine each hook with its outputs
 * 2. Build final array without hook_output messages, using combined hooks
 */
function combineAllHooks(messages: UiMessage[]): UiMessage[] {
    // Pass 1: Build map of combined hooks by timestamp
    const combinedHooksByTs = new Map<number, UiMessage>()

    for (let i = 0; i < messages.length; i++) {
        if (isHookStatusSay(getSay(messages[i]))) {
            const { combined, nextIndex } = combineHookWithOutputs(messages[i], i, messages)
            combinedHooksByTs.set(combined.ts, combined)
            i = nextIndex - 1 // Adjust for loop increment
        }
    }

    // Pass 2: Build result array
    const result: UiMessage[] = []

    for (const msg of messages) {
        const say = getSay(msg)
        if (isHookOutputStreamSay(say)) {
        } else if (isHookStatusSay(say)) {
            // Use combined version
            result.push(combinedHooksByTs.get(msg.ts) || msg)
        } else {
            // Keep all other messages as-is
            result.push(msg)
        }
    }

    return result
}

// ============================================================================
// MAIN FUNCTION
// ============================================================================

/**
 * Combines hooks and their output without changing chronological message order.
 * Tool/command duplicates keep their newest variant, and hook output stays with
 * its hook. Hook placement must never create a second presentation-order authority.
 *
 * @param messages Array of UiMessage objects to process
 * @returns New array with hook output combined and chronological placement preserved
 */
export function combineHookSequences(messages: UiMessage[]): UiMessage[] {
    // Phase 1: Deduplicate tool/command messages while preserving streaming partials
    const filtered = dedupeToolOrCommandMessagesByTimestamp(messages)

    // Phase 2: Combine hooks with their outputs
    const combined = combineAllHooks(filtered)

    return combined
}

export const HOOK_OUTPUT_STRING = "__HOOK_OUTPUT__"
