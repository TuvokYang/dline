import type { UiMessage } from "@shared/ExtensionMessage"

/**
 * Leave out a chat-only checkpoint that the next drawn row supersedes.
 *
 * A round whose shadow commit failed writes a checkpoint that restores only the
 * conversation. When its retry or the next round writes another checkpoint and no
 * drawn row lies between them, both return to the same visible conversation and only
 * the later one may also restore files, so showing both reads as a duplicate. The
 * row stays stored and keeps its restore point; only its row is not drawn. A row the
 * user checked out stays visible, because it marks where the task was restored to.
 */
export function dropSupersededChatOnlyCheckpoints(drawn: readonly UiMessage[]): UiMessage[] {
    return drawn.filter((message, index) => !isSupersededChatOnlyCheckpoint(message, drawn[index + 1]))
}

function isSupersededChatOnlyCheckpoint(message: UiMessage, next: UiMessage | undefined): boolean {
    if (message.say !== "checkpoint_created" || next?.say !== "checkpoint_created") return false
    if (message.isCheckpointCheckedOut) return false
    return !message.lastCheckpointHash?.length
}
