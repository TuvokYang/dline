import type { UiMessage } from "@shared/ExtensionMessage"
import type React from "react"
import { useMemo } from "react"
import BrowserSessionRow from "@/components/chat/BrowserSessionRow"
import ChatRow from "@/components/chat/ChatRow"
import { TOOL_RESPONSE_SCROLL_CLASS } from "@/components/chat/constants"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import type { MessageHandlers } from "../../types/chatTypes"
import {
    findReasoningForApiReq,
    isTextMessagePendingToolCall,
    isToolGroup,
    resolveMessageRowExpanded,
} from "../../utils/messageUtils"
import { ToolGroupRenderer } from "./ToolGroupRenderer"

interface MessageRendererProps {
    index: number
    messageOrGroup: UiMessage | UiMessage[]
    groupedMessages: (UiMessage | UiMessage[])[]
    modifiedMessages: UiMessage[]
    expandedRows: Record<number, boolean>
    onToggleExpand: (ts: number) => void
    onHeightChange: (isTaller: boolean) => void
    onAddToInput: (text: string) => void
    onSetQuote: (quote: string | null) => void
    onFollowupOptionSelect: (message: UiMessage, option: string) => Promise<void>
    messageHandlers: MessageHandlers
    footerActive: boolean
}

/**
 * Specialized component for rendering different message types
 * Handles browser sessions, regular messages, and checkpoint logic
 */
export const MessageRenderer: React.FC<MessageRendererProps> = ({
    index,
    messageOrGroup,
    groupedMessages,
    modifiedMessages,
    expandedRows,
    onToggleExpand,
    onHeightChange,
    onAddToInput,
    onSetQuote,
    onFollowupOptionSelect,
    messageHandlers,
    footerActive,
}) => {
    const { mode } = useExtensionState()

    const isLastMessage = useMemo(() => index === groupedMessages?.length - 1, [groupedMessages, index])

    // Get reasoning content and response status for api_req_started messages
    const reasoningData = useMemo(() => {
        if (!Array.isArray(messageOrGroup) && messageOrGroup.say === "api_req_started") {
            // Use the same message source-of-truth that `groupedMessages` is derived from.
            return findReasoningForApiReq(messageOrGroup.ts, modifiedMessages)
        }
        return { reasoning: undefined, responseStarted: false }
    }, [messageOrGroup, modifiedMessages])

    // Check if a text message is waiting for tool call completion
    const isRequestInProgress = useMemo(() => {
        if (!Array.isArray(messageOrGroup) && messageOrGroup.say === "text") {
            // Use modifiedMessages so this stays consistent with the rendered list.
            return isTextMessagePendingToolCall(messageOrGroup.ts, modifiedMessages)
        }
        return false
    }, [messageOrGroup, modifiedMessages])

    // Tool group (low-stakes tools grouped together)
    // Determine if this is the last tool group to show active items
    const isLastToolGroup = useMemo(() => {
        if (!isToolGroup(messageOrGroup)) {
            return false
        }
        // Find the last tool group in groupedMessages
        for (let i = groupedMessages.length - 1; i >= 0; i--) {
            if (isToolGroup(groupedMessages[i])) {
                return i === index
            }
        }
        return false
    }, [messageOrGroup, groupedMessages, index])

    if (isToolGroup(messageOrGroup)) {
        return (
            <div className={TOOL_RESPONSE_SCROLL_CLASS} data-testid="tool-group-scroll">
                <ToolGroupRenderer allMessages={modifiedMessages} isLastGroup={isLastToolGroup} messages={messageOrGroup} />
            </div>
        )
    }

    // Browser session group
    if (Array.isArray(messageOrGroup)) {
        return (
            <BrowserSessionRow
                expandedRows={expandedRows}
                isLast={isLastMessage}
                key={messageOrGroup[0]?.ts}
                lastModifiedMessage={modifiedMessages.at(-1)}
                messages={messageOrGroup}
                onHeightChange={onHeightChange}
                onSetQuote={onSetQuote}
                onToggleExpand={onToggleExpand}
            />
        )
    }

    // Regular message
    return (
        <div
            className={cn({
                "pb-2.5": isLastMessage && !footerActive,
            })}
            data-message-ts={messageOrGroup.ts}>
            <ChatRow
                isExpanded={resolveMessageRowExpanded(messageOrGroup, expandedRows)}
                isLast={isLastMessage}
                isRequestInProgress={isRequestInProgress}
                key={messageOrGroup.ts}
                lastModifiedMessage={modifiedMessages.at(-1)}
                message={messageOrGroup}
                mode={mode}
                onAddToInput={onAddToInput}
                onFollowupOptionSelect={onFollowupOptionSelect}
                onHeightChange={onHeightChange}
                onSetQuote={onSetQuote}
                onToggleExpand={onToggleExpand}
                reasoningContent={reasoningData.reasoning}
                responseStarted={reasoningData.responseStarted}
                sendMessageFromChatRow={messageHandlers.handleSendMessage}
            />
        </div>
    )
}

/**
 * Factory function to create the itemContent callback for Virtuoso
 * This allows us to encapsulate the rendering logic while maintaining performance
 */
export const createMessageRenderer = (
    groupedMessages: (UiMessage | UiMessage[])[],
    modifiedMessages: UiMessage[],
    expandedRows: Record<number, boolean>,
    onToggleExpand: (ts: number) => void,
    onHeightChange: (isTaller: boolean) => void,
    onAddToInput: (text: string) => void,
    onSetQuote: (quote: string | null) => void,
    onFollowupOptionSelect: (message: UiMessage, option: string) => Promise<void>,
    messageHandlers: MessageHandlers,
    footerActive: boolean,
) => {
    return (index: number, messageOrGroup: UiMessage | UiMessage[]) => (
        <MessageRenderer
            expandedRows={expandedRows}
            footerActive={footerActive}
            groupedMessages={groupedMessages}
            index={index}
            messageHandlers={messageHandlers}
            messageOrGroup={messageOrGroup}
            modifiedMessages={modifiedMessages}
            onAddToInput={onAddToInput}
            onFollowupOptionSelect={onFollowupOptionSelect}
            onHeightChange={onHeightChange}
            onSetQuote={onSetQuote}
            onToggleExpand={onToggleExpand}
        />
    )
}
