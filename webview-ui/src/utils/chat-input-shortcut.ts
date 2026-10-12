import { type ChatInputSendShortcut, getChatInputSendShortcutLabel } from "@shared/ChatInputSendShortcut"

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
 * A key held with Shift while Enter is pressed, which hands the draft to the
 * queue instead of sending it.
 *
 * The chords are fixed rather than following the configured send shortcut, so
 * they mean the same thing whichever key sends.
 */
export type QueueChord = "queue" | "queue_plain_text"

/** The `KeyboardEvent.code` of the key held for each chord, independent of keyboard layout. */
export const QUEUE_CHORD_KEY_CODES: Readonly<Record<QueueChord, string>> = {
    queue: "KeyQ",
    queue_plain_text: "KeyS",
}

/** The shortcut for each way the composer can hand a draft over, as shown to the user. */
export interface ComposerShortcutLabels {
    readonly send: string
    readonly queue: string
    readonly queuePlainText: string
}

/** Labels for the composer's shortcuts under the configured send shortcut. */
export function composerShortcutLabels(shortcut: ChatInputSendShortcut | undefined): ComposerShortcutLabels {
    return {
        send: getChatInputSendShortcutLabel(shortcut),
        queue: "Shift + Q + Enter",
        queuePlainText: "Shift + S + Enter",
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
