import type { ChatInputSendShortcut } from "@shared/ChatInputSendShortcut"

export interface ChatInputKeyEvent {
    key: string
    altKey: boolean
    ctrlKey: boolean
    metaKey: boolean
    shiftKey: boolean
}

export function shouldSendChatInput(event: ChatInputKeyEvent, shortcut: ChatInputSendShortcut, isComposing: boolean): boolean {
    if (event.key !== "Enter" || isComposing || event.altKey || event.metaKey) {
        return false
    }

    switch (shortcut) {
        case "ctrlEnter":
            return event.ctrlKey && !event.shiftKey
        case "shiftEnter":
            return event.shiftKey && !event.ctrlKey
        case "enter":
            return !event.ctrlKey && !event.shiftKey
    }
}

/**
 * Whether this key press accepts the highlighted suggestion instead of submitting.
 *
 * An open suggestion list owns Tab and the bare Enter, because that is how a
 * command or mention is completed. It must not own the configured send
 * shortcut: when sending requires a modifier, the modified Enter is an explicit
 * submit, and swallowing it left the typed command sitting in the input with no
 * request ever made.
 *
 * When Enter itself is the send shortcut there is no way to distinguish the two,
 * so completion keeps priority and the submit follows the next press.
 */
export function shouldCompleteMenuSelection(
    event: ChatInputKeyEvent,
    shortcut: ChatInputSendShortcut,
    isComposing: boolean,
): boolean {
    if (isComposing) return false
    if (event.key === "Tab") return true
    if (event.key !== "Enter") return false
    if (shortcut === "enter") return true
    return !shouldSendChatInput(event, shortcut, isComposing)
}
