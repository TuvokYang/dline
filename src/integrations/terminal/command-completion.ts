import type { TerminalCompletionDetails } from "./types"

/** Return true only when process completion explicitly proves success. */
export function isCommandCompletionSuccessful(details: TerminalCompletionDetails | undefined): boolean {
    return details?.exitCode === 0 && details.signal == null
}
