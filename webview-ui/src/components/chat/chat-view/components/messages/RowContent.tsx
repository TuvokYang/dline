import type { UiMessage } from "@shared/ExtensionMessage"
import type React from "react"
import { useMemo } from "react"
import BrowserSessionRow from "@/components/chat/BrowserSessionRow"
import ChatRow from "@/components/chat/ChatRow"
import { TOOL_RESPONSE_SCROLL_CLASS } from "@/components/chat/constants"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { cn } from "@/lib/utils"
import type { RowExpansionOrigin } from "../../types/chatTypes"
import { isBrowserSession, isExplorationRun } from "../../utils/chatRowKinds"
import { isTextMessagePendingToolCall, isToolGroup, resolveMessageRowExpanded } from "../../utils/messageUtils"
import { CheckpointMarker } from "./CheckpointMarker"
import { ExplorationRunRenderer } from "./ExplorationRunRenderer"
import { ToolGroupRenderer } from "./ToolGroupRenderer"

/** What every drawn row needs from the chat, whether it sits in the list or inside a fold. */
export interface RowRenderContext {
    modifiedMessages: UiMessage[]
    checkpointAttachments: ReadonlyMap<number, UiMessage[]>
    expandedRows: Record<number, boolean>
    onToggleExpand: (ts: number, origin?: RowExpansionOrigin) => void
    onHeightChange: (isTaller: boolean) => void
    onAddToInput: (text: string) => void
    onSetQuote: (quote: string | null) => void
    onFollowupOptionSelect: (message: UiMessage, option: string) => Promise<void>
    footerActive: boolean
}

interface RowContentProps extends RowRenderContext {
    row: UiMessage | UiMessage[]
    /** Whether the row is the list's last row, which owns the live tail of the task. */
    isLastRow: boolean
    /** Whether the row is the newest one drawing low-stakes tool calls; only it shows calls still executing. */
    isLastToolActivity: boolean
}

function AttachedCheckpoint({ message }: { message: UiMessage }) {
    return (
        <div className="px-4">
            <CheckpointMarker message={message} />
        </div>
    )
}

/**
 * Draws one chat row: a message, a tool group, an exploration run or a browser
 * session.
 *
 * Position in the list is an explicit input rather than derived here, so a
 * fold can draw its members without any of them being taken for the list's
 * last row.
 */
export const RowContent: React.FC<RowContentProps> = ({
    row,
    isLastRow,
    isLastToolActivity,
    modifiedMessages,
    checkpointAttachments,
    expandedRows,
    onToggleExpand,
    onHeightChange,
    onAddToInput,
    onSetQuote,
    onFollowupOptionSelect,
    footerActive,
}) => {
    const { mode } = useExtensionState()

    const rowMessageTimestamps = useMemo(() => new Set((Array.isArray(row) ? row : [row]).map((message) => message.ts)), [row])
    const attachedCheckpoints = useMemo(
        () => Array.from(rowMessageTimestamps).flatMap((toolTs) => checkpointAttachments.get(toolTs) ?? []),
        [checkpointAttachments, rowMessageTimestamps],
    )

    // Check if a text message is waiting for tool call completion
    const isRequestInProgress = useMemo(() => {
        if (!Array.isArray(row) && row.say === "text") {
            // Use modifiedMessages so this stays consistent with the rendered list.
            return isTextMessagePendingToolCall(row.ts, modifiedMessages)
        }
        return false
    }, [row, modifiedMessages])

    if (isExplorationRun(row)) {
        return (
            <ExplorationRunRenderer
                allMessages={modifiedMessages}
                expandedRows={expandedRows}
                isLastActivity={isLastToolActivity}
                isLastRow={isLastRow}
                onToggleExpand={onToggleExpand}
                run={row}
            />
        )
    }

    if (isToolGroup(row)) {
        return (
            <div>
                <div className={TOOL_RESPONSE_SCROLL_CLASS} data-testid="tool-group-scroll">
                    <ToolGroupRenderer allMessages={modifiedMessages} isLastGroup={isLastToolActivity} messages={row} />
                </div>
                {attachedCheckpoints.map((checkpoint) => (
                    <AttachedCheckpoint key={checkpoint.ts} message={checkpoint} />
                ))}
            </div>
        )
    }

    // Browser session group
    if (Array.isArray(row)) {
        return (
            <BrowserSessionRow
                end={isBrowserSession(row) ? row._end : undefined}
                expandedRows={expandedRows}
                isLast={isLastRow}
                key={row[0]?.ts}
                lastModifiedMessage={modifiedMessages.at(-1)}
                messages={row}
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
                "pb-2.5": isLastRow && !footerActive,
            })}
            data-message-ts={row.ts}>
            <ChatRow
                isExpanded={resolveMessageRowExpanded(row, expandedRows)}
                isLast={isLastRow}
                isRequestInProgress={isRequestInProgress}
                key={row.ts}
                lastModifiedMessage={modifiedMessages.at(-1)}
                message={row}
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
