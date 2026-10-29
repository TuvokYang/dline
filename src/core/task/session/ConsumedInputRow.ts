import { rowHasVisibleContent, type SubmittedInputRow, submittedRowFields } from "@shared/input-semantics/submitted-input"
import type { MessageStateHandler } from "../message-state"

/** Shows a submission its lifecycle command consumed, as the user typed it. */
export interface ConsumedInputRowPort {
    show(shown: SubmittedInputRow, rowId: string): Promise<void>
}

/**
 * Show input whose lifecycle command consumed all of it, as the user typed it.
 *
 * Nothing else echoes such input: a dialog handler echoes only the text a reply
 * keeps, and a command carried out instead of queued never becomes an intake
 * entry whose admission would draw it. Keyed by `rowId` so a replayed
 * submission cannot show it twice, and durable once this resolves: once the
 * submission is acknowledged no replay can recreate a row a crash dropped from
 * the buffer.
 *
 * The row is registered before the first await, so it is in the chat before
 * the caller releases anything that waits on the command: a summary the
 * command produces is published after the user's row.
 *
 * Built from the input as submitted, never from its resolved attachments: the
 * receiver reads the resources, the row only names them, so no image data or
 * local path enters the chat history and no file is read twice.
 */
export async function showConsumedInput(
    messages: MessageStateHandler,
    nextPresentationId: (() => number) | undefined,
    shown: SubmittedInputRow,
    rowId: string,
): Promise<void> {
    if (!rowHasVisibleContent(shown) || messages.clineMessages.some((row) => row.interactionId === rowId)) return
    // Rows are ordered by the session's shared sequence; drawing from it keeps
    // the input ahead of the summary and the turn it causes.
    const lastTs = messages.clineMessages.at(-1)?.ts ?? 0
    const ts = nextPresentationId ? nextPresentationId() : Math.max(Date.now(), lastTs + 1)
    const registered = messages.beginDurableClineMessage({
        ts,
        type: "say",
        say: "user_feedback",
        ...submittedRowFields(shown),
        interactionId: rowId,
    })
    await registered.persistence
}
