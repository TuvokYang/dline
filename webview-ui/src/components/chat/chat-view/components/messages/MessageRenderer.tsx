import { indexPreEditCheckpointAttachments } from "@shared/chat/drawnMessages"
import type { UiMessage } from "@shared/ExtensionMessage"
import type React from "react"
import { useMemo } from "react"
import type { FoldExpansion, MessageHandlers, RowExpansionOrigin } from "../../types/chatTypes"
import { isActivityFold, isExplorationRun } from "../../utils/chatRowKinds"
import { isToolGroup } from "../../utils/messageUtils"
import { ROW_TS_ATTRIBUTE } from "../../utils/viewportRowAnchor"
import { ActivityFoldRenderer } from "./ActivityFoldRenderer"
import { RowContent } from "./RowContent"

/** Rows that draw low-stakes tool calls; only the newest one shows the calls still executing. */
function drawsToolActivity(row: UiMessage | UiMessage[]): boolean {
    return isToolGroup(row) || isExplorationRun(row)
}

/** No fold is expanded and toggling does nothing: the list draws no folds at the standard level. */
const NO_FOLD_EXPANSION: FoldExpansion = { expanded: {}, toggle: () => {} }

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
    foldExpansion?: FoldExpansion
}

/**
 * Draws the row at `index` of the chat list.
 *
 * It decides where the row sits in the list (last row, newest tool activity)
 * and hands the drawing to `RowContent`, or to `ActivityFoldRenderer` for a
 * folded block.
 */
export const MessageRenderer: React.FC<MessageRendererProps> = ({
    index,
    messageOrGroup,
    groupedMessages,
    messageHandlers: _messageHandlers,
    foldExpansion = NO_FOLD_EXPANSION,
    ...context
}) => {
    const isLastMessage = useMemo(() => index === groupedMessages?.length - 1, [groupedMessages, index])

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

    // A fold is an array row too, so it must be recognised before the browser-session fallback.
    if (isActivityFold(messageOrGroup)) {
        return (
            <ActivityFoldRenderer
                {...context}
                fold={messageOrGroup}
                isExpanded={foldExpansion.expanded[messageOrGroup._activityFoldId] === true}
                onToggleFold={foldExpansion.toggle}
            />
        )
    }

    return <RowContent {...context} isLastRow={isLastMessage} isLastToolActivity={isLastToolActivity} row={messageOrGroup} />
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
    foldExpansion: FoldExpansion = NO_FOLD_EXPANSION,
) => {
    const checkpointAttachments = indexPreEditCheckpointAttachments(modifiedMessages)
    return (index: number, messageOrGroup: UiMessage | UiMessage[]) => (
        // Box-less, so it adds a row identity every row kind shares without changing layout.
        <div className="contents" {...{ [ROW_TS_ATTRIBUTE]: rowTs(messageOrGroup) }}>
            <MessageRenderer
                checkpointAttachments={checkpointAttachments}
                expandedRows={expandedRows}
                foldExpansion={foldExpansion}
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
        </div>
    )
}

/** The ts that places a rendered row in the conversation: its first message's. */
export function rowTs(messageOrGroup: UiMessage | UiMessage[]): number | undefined {
    return Array.isArray(messageOrGroup) ? messageOrGroup[0]?.ts : messageOrGroup.ts
}
