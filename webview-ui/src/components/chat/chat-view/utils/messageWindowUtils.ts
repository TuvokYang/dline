import type { UiMessage } from "@shared/ExtensionMessage"
import { fetchedCopySupersedes } from "@/context/messageWindowSync"

export type BottomFollowIntent = "follow" | "none"

export interface MergeMessageWindowInput {
    existing: UiMessage[]
    incoming: UiMessage[]
    existingStartIndex: number
    incomingStartIndex: number
}

export interface MergeMessageWindowResult {
    messages: UiMessage[]
    firstItemIndex: number
    merged: boolean
}

export interface BottomFollowInput {
    disableAutoScroll: boolean
    absoluteBottomLoaded: boolean
    lastMessageTsChanged: boolean
    lastMessageContentChanged: boolean
}

export interface RestoreBottomInput {
    wasHidden: boolean
    isVisible: boolean
    disableAutoScroll: boolean
    wasAtBottom: boolean
}

interface IndexedMessage {
    index: number
    message: UiMessage
    order: number
}

/**
 * Merge fetched messages into a sliding window by absolute index and message timestamp.
 *
 * @param input Existing and incoming message windows with their absolute start indexes.
 * @returns A merged contiguous message window and its first absolute index.
 */
export function mergeMessageWindow(input: MergeMessageWindowInput): MergeMessageWindowResult {
    const { existing, incoming, existingStartIndex, incomingStartIndex } = input

    if (incoming.length === 0) {
        return {
            messages: existing,
            firstItemIndex: existingStartIndex,
            merged: false,
        }
    }

    if (existing.length === 0) {
        return {
            messages: incoming,
            firstItemIndex: incomingStartIndex,
            merged: true,
        }
    }

    const existingEnd = existingStartIndex + existing.length
    const incomingEnd = incomingStartIndex + incoming.length
    const windowsTouch = incomingStartIndex <= existingEnd && incomingEnd >= existingStartIndex

    if (!windowsTouch) {
        return {
            messages: existing,
            firstItemIndex: existingStartIndex,
            merged: false,
        }
    }

    const indexedMessages = buildIndexedMessages(existing, existingStartIndex, incoming, incomingStartIndex)
    const mergedMessages = dedupeMessages(indexedMessages)
    const firstItemIndex = mergedMessages.at(0)?.index ?? existingStartIndex
    const messages = mergedMessages.map((item) => item.message)

    if (firstItemIndex === existingStartIndex && areMessageWindowsEqual(existing, messages)) {
        return {
            messages: existing,
            firstItemIndex: existingStartIndex,
            merged: false,
        }
    }

    return {
        messages,
        firstItemIndex,
        merged: true,
    }
}

/**
 * Compare two message windows by serialized message content.
 *
 * @param left First message window.
 * @param right Second message window.
 * @returns True when both windows contain identical message data.
 */
function areMessageWindowsEqual(left: UiMessage[], right: UiMessage[]): boolean {
    if (left.length !== right.length) {
        return false
    }

    return left.every((message, index) => JSON.stringify(message) === JSON.stringify(right[index]))
}

/**
 * Build a stable key for a Virtuoso row from message timestamps.
 *
 * @param row Single message or grouped messages rendered as one row.
 * @param fallbackIndex Row index used only when a timestamp is unavailable.
 * @returns Stable row key for virtual-list DOM identity.
 */
export function buildMessageRowKey(row: UiMessage | UiMessage[], fallbackIndex: number): string {
    if (Array.isArray(row)) {
        const firstTs = row.at(0)?.ts
        const lastTs = row.at(-1)?.ts
        if (firstTs != null && lastTs != null) {
            return `group:${firstTs}-${lastTs}:${row.length}`
        }
        return `group:fallback-${fallbackIndex}:${row.length}`
    }

    if (row.ts != null) {
        return `message:${row.ts}`
    }

    return `message:fallback-${fallbackIndex}`
}

/**
 * Decide whether the chat should keep following the latest rendered bottom row.
 *
 * @param input Current auto-scroll and latest-message state.
 * @returns Follow intent when the bottom should be restored after layout.
 */
export function getBottomFollowIntent(input: BottomFollowInput): BottomFollowIntent {
    if (input.disableAutoScroll) {
        return "none"
    }

    if (!input.absoluteBottomLoaded) {
        return "none"
    }

    if (input.lastMessageTsChanged || input.lastMessageContentChanged) {
        return "follow"
    }

    return "none"
}

/**
 * Decide whether a hidden webview should restore the bottom on visibility return.
 *
 * @param input Previous visibility and auto-scroll state.
 * @returns True when the view should scroll to the bottom after restore.
 */
export function shouldRestoreBottom(input: RestoreBottomInput): boolean {
    return input.wasHidden && input.isVisible && !input.disableAutoScroll && input.wasAtBottom
}

/**
 * Attach absolute indexes to existing and incoming messages.
 *
 * @param existing Existing loaded message window.
 * @param existingStartIndex Absolute start index of the existing window.
 * @param incoming Fetched incoming message window.
 * @param incomingStartIndex Absolute start index of the incoming window.
 * @returns Indexed messages in replacement order.
 */
function buildIndexedMessages(
    existing: UiMessage[],
    existingStartIndex: number,
    incoming: UiMessage[],
    incomingStartIndex: number,
): IndexedMessage[] {
    const indexedMessages: IndexedMessage[] = []
    let order = 0

    for (const [offset, message] of existing.entries()) {
        indexedMessages.push({ index: existingStartIndex + offset, message, order })
        order += 1
    }

    for (const [offset, message] of incoming.entries()) {
        indexedMessages.push({ index: incomingStartIndex + offset, message, order })
        order += 1
    }

    return indexedMessages
}

/**
 * Remove duplicate absolute indexes and duplicate timestamps from indexed messages.
 *
 * @param indexedMessages Indexed messages in replacement order.
 * @returns Sorted and deduplicated indexed messages.
 */
function dedupeMessages(indexedMessages: IndexedMessage[]): IndexedMessage[] {
    const byIndex = new Map<number, IndexedMessage>()
    for (const item of indexedMessages) {
        byIndex.set(item.index, laterEntry(byIndex.get(item.index), item))
    }

    const byTs = new Map<number, IndexedMessage>()
    for (const item of byIndex.values()) {
        byTs.set(item.message.ts, laterEntry(byTs.get(item.message.ts), item))
    }

    return Array.from(byTs.values()).sort((left, right) => left.index - right.index)
}

/**
 * The entry that wins when two claim the same slot: normally the later one.
 *
 * Incoming entries come from a fetched page, a snapshot older than its arrival,
 * so a partial copy in it never replaces a copy already held for the same row.
 */
function laterEntry(held: IndexedMessage | undefined, item: IndexedMessage): IndexedMessage {
    if (!held) return item
    const [earlier, later] = held.order < item.order ? [held, item] : [item, held]
    const sameRow = earlier.message.ts === later.message.ts
    return sameRow && !fetchedCopySupersedes(later.message) ? earlier : later
}
