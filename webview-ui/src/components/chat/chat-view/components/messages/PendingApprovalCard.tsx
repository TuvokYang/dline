import type { UiMessage } from "@shared/ExtensionMessage"
import { useCallback } from "react"
import BrowserSessionRow from "@/components/chat/BrowserSessionRow"
import ChatRow from "@/components/chat/ChatRow"
import { useExtensionState } from "@/context/ExtensionStateContext"
import type { ChatState } from "../../types/chatTypes"
import { isBrowserSessionMessage, resolveMessageRowExpanded, toggleMessageRowExpansion } from "../../utils/messageUtils"

interface PendingApprovalCardProps {
    message: UiMessage
    lastModifiedMessage: UiMessage | undefined
    chatState: Pick<ChatState, "expandedRows" | "setExpandedRows" | "setActiveQuote">
}

// The footer sizes itself; only the chat list follows row growth to stay at the bottom.
const ignoreHeightChange = () => {}

/**
 * The card of a call waiting for approval, drawn in the footer above Approve and
 * Reject by the same component the chat draws it with once the approval is answered.
 *
 * Expansion lives in the chat's row state, so a card opened here stays open when
 * the row lands in the chat.
 */
export function PendingApprovalCard({ message, lastModifiedMessage, chatState }: PendingApprovalCardProps) {
    const { mode } = useExtensionState()
    const { expandedRows, setExpandedRows, setActiveQuote } = chatState
    const toggleExpand = useCallback(
        () => setExpandedRows((rows) => toggleMessageRowExpansion(message, rows)),
        [message, setExpandedRows],
    )

    // The bottom gap separates the card from the Approve and Reject row beneath it.
    return (
        <div className="pb-2" data-testid="pending-approval-card">
            {isBrowserSessionMessage(message) ? (
                <BrowserSessionRow
                    expandedRows={expandedRows}
                    isLast
                    lastModifiedMessage={lastModifiedMessage}
                    messages={[message]}
                    onHeightChange={ignoreHeightChange}
                    onSetQuote={setActiveQuote}
                    onToggleExpand={toggleExpand}
                />
            ) : (
                <ChatRow
                    isExpanded={resolveMessageRowExpanded(message, expandedRows)}
                    isLast
                    lastModifiedMessage={lastModifiedMessage}
                    message={message}
                    mode={mode}
                    onSetQuote={setActiveQuote}
                    onToggleExpand={toggleExpand}
                />
            )}
        </div>
    )
}
