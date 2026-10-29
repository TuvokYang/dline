import { findLastIndex } from "@shared/array"
import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"

/** A position in the task's conversation journal. */
export interface ConversationJournalPosition {
    readonly seq: number
}

export interface ChatRestoreBoundary {
    readonly apiKeepCount: number
    readonly uiKeepCount: number
    readonly contextAnchorTs: number
    readonly runtimeApiIndex: number
    readonly conversationHistoryDeletedRange?: [number, number]
    /**
     * Journal position the provider conversation returns to.
     *
     * Present only for a card written by the Task runtime, whose conversation
     * lives in the journal; the legacy API rows are then left untouched.
     */
    readonly journalTarget?: ConversationJournalPosition
}

/** A row together with its index in the durable chat sequence. */
export interface ChatRestoreRow {
    readonly message: UiMessage
    readonly index: number
}

/**
 * The row whose chat state a restore of `messages[messageIndex]` returns to.
 *
 * A checkpoint added before a file edit is a file restore point only: its chat
 * part is the checkpoint it was anchored to, written before the round's request.
 * Returning the chat to the edit's own position would keep the round's later
 * rows on screen while the conversation no longer holds them, so the chat is
 * cut at the anchor instead. Every other row is its own chat restore point.
 */
export function chatRestoreRow(messages: readonly UiMessage[], messageIndex: number): ChatRestoreRow {
    const message = messages[messageIndex]
    if (!message) throw new Error(`Restore message index ${messageIndex} is unavailable`)
    const anchorTs = message.checkpointAnchorTs
    if (anchorTs === undefined) return { message, index: messageIndex }
    const anchorIndex = findLastIndex(messages.slice(0, messageIndex), (row) => row.ts === anchorTs)
    if (anchorIndex < 0) throw new Error("Restore checkpoint anchor is unavailable")
    return { message: messages[anchorIndex], index: anchorIndex }
}

/** Resolve and validate every chat rewind boundary before any store is mutated. */
export function resolveChatRestoreBoundary(input: {
    readonly messages: readonly UiMessage[]
    readonly messageIndex: number
    readonly apiCount: number
    readonly uiCount: number
}): ChatRestoreBoundary {
    const { messages, messageIndex, apiCount, uiCount } = input
    const message = messages[messageIndex]
    if (!message) throw new Error(`Restore message index ${messageIndex} is unavailable`)
    if (uiCount !== messages.length) {
        throw new Error(`Restore UI history is stale: loaded=${messages.length}, durable=${uiCount}`)
    }

    const compactionRange = message.compactionConversationRange
    const journalTarget = compactionRange ? undefined : readCompactionJournalBoundary(message)
    if (journalTarget) {
        // The summary card itself is the first row the rewind removes, so the
        // row before it anchors the context history exactly as a range card does.
        if (messageIndex <= 0) throw new Error("Compaction Restore boundary is inconsistent with the current conversation")
        // API rows are not this conversation's record, so they are kept as they
        // are and the deleted range, an API-row fact, is carried through unchecked.
        return {
            apiKeepCount: apiCount,
            uiKeepCount: messageIndex,
            contextAnchorTs: messages[messageIndex - 1].ts,
            runtimeApiIndex: apiCount - 1,
            conversationHistoryDeletedRange: cloneDeletedRange(message.conversationHistoryDeletedRange),
            journalTarget,
        }
    }
    if (compactionRange) {
        const [turnStart, turnEnd] = compactionRange.logicalTurnRange
        const [apiStart, apiEnd] = compactionRange.apiConversationRange
        const preCompactionApiEndIndex = compactionRange.preCompactionApiEndIndex
        if (
            ![turnStart, turnEnd, apiStart, apiEnd, preCompactionApiEndIndex].every(Number.isInteger) ||
            turnStart < 0 ||
            turnEnd < turnStart ||
            apiStart < 0 ||
            apiEnd < apiStart ||
            apiEnd > preCompactionApiEndIndex ||
            preCompactionApiEndIndex >= apiCount ||
            message.conversationHistoryIndex !== preCompactionApiEndIndex ||
            messageIndex <= 0
        ) {
            throw new Error("Compaction Restore boundary is inconsistent with the current conversation")
        }
        validateDeletedRange(message.conversationHistoryDeletedRange, preCompactionApiEndIndex + 1)
        return {
            apiKeepCount: preCompactionApiEndIndex + 1,
            uiKeepCount: messageIndex,
            contextAnchorTs: messages[messageIndex - 1].ts,
            runtimeApiIndex: preCompactionApiEndIndex,
            conversationHistoryDeletedRange: cloneDeletedRange(message.conversationHistoryDeletedRange),
        }
    }

    const userMessageIndex = (message.conversationHistoryIndex ?? -1) + 1
    // An ordinary card points at the assistant message of its round, so the round is
    // kept through the following user message. A failed compaction card is anchored to
    // the last assistant message of an unfinished round and has no successor user
    // message, so the same arithmetic would run one past the end of the conversation.
    // Clamp to the conversation length instead of rejecting a legitimate restore.
    const apiKeepCount = Math.min(userMessageIndex + 1, apiCount)
    if (!Number.isInteger(apiKeepCount) || apiKeepCount < 0 || userMessageIndex > apiCount) {
        throw new Error("Restore API boundary is outside the current conversation")
    }
    validateDeletedRange(message.conversationHistoryDeletedRange, apiKeepCount)
    return {
        apiKeepCount,
        uiKeepCount: messageIndex + 1,
        contextAnchorTs: message.ts,
        runtimeApiIndex: apiKeepCount - 1,
        conversationHistoryDeletedRange: cloneDeletedRange(message.conversationHistoryDeletedRange),
    }
}

/**
 * The journal position a completed Task-runtime summary card restores to.
 *
 * Read from the tool payload because that is the part of the row that reaches
 * the Webview unchanged, so the card that offers Restore and the boundary that
 * performs it read the same fact. A malformed position is treated as absent
 * rather than guessed, which leaves the card on the ordinary restore path.
 */
function readCompactionJournalBoundary(message: UiMessage): ConversationJournalPosition | undefined {
    if (message.say !== "tool" || message.partial === true || !message.text) return undefined
    let payload: UiSayTool
    try {
        payload = JSON.parse(message.text) as UiSayTool
    } catch {
        return undefined
    }
    if (payload.tool !== "summarizeTask" || payload.compactionStatus !== "completed") return undefined
    const boundary = payload.compactionJournalBoundary
    if (!boundary) return undefined
    const { seq } = boundary
    if (!Number.isInteger(seq) || seq < 1) {
        throw new Error("Compaction Restore boundary is inconsistent with the current conversation")
    }
    return { seq }
}

function validateDeletedRange(range: [number, number] | undefined, apiKeepCount: number): void {
    if (!range) return
    const [start, end] = range
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= apiKeepCount) {
        throw new Error("Restore deleted range is outside the target API boundary")
    }
}

function cloneDeletedRange(range: [number, number] | undefined): [number, number] | undefined {
    return range ? [...range] : undefined
}
