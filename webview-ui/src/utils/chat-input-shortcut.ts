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

/** The parts of a key press the steer shortcut reads. */
export interface SteerShortcutKeyEvent extends ChatInputKeyEvent {
    readonly code: string
    getModifierState?(key: string): boolean
}

/**
 * Whether a key press hands the draft to the queue as steering input, which the
 * running turn takes at its next tool round: Ctrl + Alt + S. A plain queued
 * entry needs no shortcut of its own, since the send shortcut queues whenever
 * the task is busy.
 *
 * The key is matched by its physical position, so it works on any layout. Each
 * alternative was ruled out by how it behaved: a letter held with Shift types
 * itself unless it is caught at exactly the right moment, Alt alone moves focus
 * to the VS Code menu bar, and Ctrl + S reaches VS Code first. On layouts with
 * an AltGr key, Ctrl + Alt is AltGr and may type a character, so a press with
 * AltGr down is left to type it.
 */
export function isSteerShortcut(event: SteerShortcutKeyEvent, isComposing: boolean): boolean {
    if (isComposing || event.code !== "KeyS") return false
    if (!event.ctrlKey || !event.altKey || event.shiftKey || event.metaKey) return false
    return !event.getModifierState?.("AltGraph")
}

/** The shortcut for each way the composer can hand a draft over, as shown to the user. */
export interface ComposerShortcutLabels {
    readonly send: string
    readonly steer: string
}

/** Labels for the composer's shortcuts under the configured send shortcut. */
export function composerShortcutLabels(shortcut: ChatInputSendShortcut | undefined): ComposerShortcutLabels {
    return {
        send: getChatInputSendShortcutLabel(shortcut),
        steer: "Ctrl + Alt + S",
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
