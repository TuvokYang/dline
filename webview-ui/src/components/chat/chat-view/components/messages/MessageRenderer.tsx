import type { UiMessage } from "@shared/ExtensionMessage"
import type React from "react"
import { useMemo } from "react"
import BrowserSessionRow from "@/components/chat/BrowserSessionRow"
import ChatRow from "@/components/chat/ChatRow"
import { TOOL_RESPONSE_SCROLL_CLASS } from "@/components/chat/constants"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import type { MessageHandlers, RowExpansionOrigin } from "../../types/chatTypes"
import { isBrowserSession, isExplorationRun } from "../../utils/chatRowKinds"
import {
    indexPreEditCheckpointAttachments,
    isTextMessagePendingToolCall,
    isToolGroup,
    resolveMessageRowExpanded,
} from "../../utils/messageUtils"
import { CheckpointMarker } from "./CheckpointMarker"
import { ExplorationRunRenderer } from "./ExplorationRunRenderer"
import { ToolGroupRenderer } from "./ToolGroupRenderer"

function AttachedCheckpoint({ message }: { message: UiMessage }) {
    return (
        <div className="px-4">
            <CheckpointMarker message={message} />
        </div>
    )
}

/** Rows that draw low-stakes tool calls; only the newest one shows the calls still executing. */
function drawsToolActivity(row: UiMessage | UiMessage[]): boolean {
    return isToolGroup(row) || isExplorationRun(row)
}

interface MessageRendererProps {
    index: number
    messageOrGroup: UiMessage | UiMessage[]
    groupedMessages: (UiMessage | UiMessage[])[]
    modifiedMessages: UiMessage[]
    checkpointAttachments: ReadonlyMap<number, UiMessage[]>
    expandedRows: Record<number, boolean>
    onToggleExpand: (ts: number, origin?: RowExpansionOrigin) => void
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
    checkpointAttachments,
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
    const rowMessageTimestamps = useMemo(
        () => new Set((Array.isArray(messageOrGroup) ? messageOrGroup : [messageOrGroup]).map((message) => message.ts)),
        [messageOrGroup],
    )
    const attachedCheckpoints = useMemo(
        () => Array.from(rowMessageTimestamps).flatMap((toolTs) => checkpointAttachments.get(toolTs) ?? []),
        [checkpointAttachments, rowMessageTimestamps],
    )

    // Check if a text message is waiting for tool call completion
    const isRequestInProgress = useMemo(() => {
        if (!Array.isArray(messageOrGroup) && messageOrGroup.say === "text") {
            // Use modifiedMessages so this stays consistent with the rendered list.
            return isTextMessagePendingToolCall(messageOrGroup.ts, modifiedMessages)
        }
        return false
    }, [messageOrGroup, modifiedMessages])

    // Only the newest row drawing tool calls shows the ones still executing.
    const isLastToolActivity = useMemo(() => {
        if (!drawsToolActivity(messageOrGroup)) {
            return false
        }
        for (let i = groupedMessages.length - 1; i >= 0; i--) {
            if (drawsToolActivity(groupedMessages[i])) {
                return i === index
            }
        }
        return false
    }, [messageOrGroup, groupedMessages, index])

    if (isExplorationRun(messageOrGroup)) {
        return (
            <ExplorationRunRenderer
                allMessages={modifiedMessages}
                expandedRows={expandedRows}
                isLastActivity={isLastToolActivity}
                isLastRow={isLastMessage}
                onToggleExpand={onToggleExpand}
                run={messageOrGroup}
            />
        )
    }

    if (isToolGroup(messageOrGroup)) {
        return (
            <div>
                <div className={TOOL_RESPONSE_SCROLL_CLASS} data-testid="tool-group-scroll">
                    <ToolGroupRenderer
                        allMessages={modifiedMessages}
                        isLastGroup={isLastToolActivity}
                        messages={messageOrGroup}
                    />
                </div>
                {attachedCheckpoints.map((checkpoint) => (
                    <AttachedCheckpoint key={checkpoint.ts} message={checkpoint} />
                ))}
            </div>
        )
    }

    // Browser session group
    if (Array.isArray(messageOrGroup)) {
        return (
            <BrowserSessionRow
                end={isBrowserSession(messageOrGroup) ? messageOrGroup._end : undefined}
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
                onSetQuote={onSetQuote}
                onToggleExpand={onToggleExpand}
            />
            {attachedCheckpoints.map((checkpoint) => (
                <AttachedCheckpoint key={checkpoint.ts} message={checkpoint} />
            ))}
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
    onToggleExpand: (ts: number, origin?: RowExpansionOrigin) => void,
    onHeightChange: (isTaller: boolean) => void,
    onAddToInput: (text: string) => void,
    onSetQuote: (quote: string | null) => void,
    onFollowupOptionSelect: (message: UiMessage, option: string) => Promise<void>,
    messageHandlers: MessageHandlers,
    footerActive: boolean,
) => {
    const checkpointAttachments = indexPreEditCheckpointAttachments(modifiedMessages)
    return (index: number, messageOrGroup: UiMessage | UiMessage[]) => (
        <MessageRenderer
            checkpointAttachments={checkpointAttachments}
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
