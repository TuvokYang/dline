import type { TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import { findCardHostedApproval } from "@/task-interaction/approval-card"

/**
 * Leave out of the chat the call the footer hosts while it waits for approval.
 *
 * The footer draws that call as its full card above Approve and Reject. Once the
 * approval is answered the view no longer names it, and the chat draws the row
 * like any other: an approved call in its place in the timeline, a rejected one
 * with its refusal.
 *
 * `allMessages` must be the list the footer resolves its anchor from, so both
 * sides agree on which row, if any, the footer hosts.
 */
export function withoutFooterOwnedApproval(
    visibleMessages: UiMessage[],
    allMessages: readonly UiMessage[],
    view: TaskViewState | undefined,
): UiMessage[] {
    const hosted = view ? findCardHostedApproval(allMessages, view) : undefined
    const index = hosted ? visibleMessages.indexOf(hosted) : -1
    return index === -1 ? visibleMessages : [...visibleMessages.slice(0, index), ...visibleMessages.slice(index + 1)]
}
