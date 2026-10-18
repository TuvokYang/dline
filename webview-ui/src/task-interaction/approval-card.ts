import type { TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import { findActiveInteractionAnchor } from "./types"

/**
 * Approvals whose pending call the footer draws as the same card the chat draws
 * once the call is answered: read-only tools, edits, commands, MCP, the browser,
 * subagents and new tasks. Focus-chain changes keep their own selection renderer.
 */
const CARD_HOSTED_APPROVAL_KINDS: ReadonlySet<string> = new Set([
    "tool_approval",
    "command_approval",
    "browser_approval",
    "mcp_approval",
    "subagent_approval",
    "spawn_task_approval",
])

/** Whether the footer hosts this approval kind's pending call as a full card. */
export function isCardHostedApproval(presentationKind: string | undefined): boolean {
    return presentationKind !== undefined && CARD_HOSTED_APPROVAL_KINDS.has(presentationKind)
}

/**
 * The ask row the footer hosts while its approval is pending, if any.
 *
 * The footer and the chat both resolve the row through this function from the same
 * messages and view, so exactly one of them draws it: the footer while the approval
 * waits, the chat once the view no longer names it.
 */
export function findCardHostedApproval(messages: readonly UiMessage[], view: TaskViewState): UiMessage | undefined {
    if (!isCardHostedApproval(view.activeInteraction?.presentationKind)) {
        return undefined
    }
    return findActiveInteractionAnchor(messages, view)
}
