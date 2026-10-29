export const CHAT_INPUT_SEND_SHORTCUTS = ["enter", "ctrlEnter", "shiftEnter"] as const

export type ChatInputSendShortcut = (typeof CHAT_INPUT_SEND_SHORTCUTS)[number]

export const DEFAULT_CHAT_INPUT_SEND_SHORTCUT: ChatInputSendShortcut = "enter"

export const CHAT_INPUT_SEND_SHORTCUT_LABELS: Record<ChatInputSendShortcut, string> = {
    enter: "Enter",
    ctrlEnter: "Ctrl + Enter",
    shiftEnter: "Shift + Enter",
}

export function isChatInputSendShortcut(value: unknown): value is ChatInputSendShortcut {
    return CHAT_INPUT_SEND_SHORTCUTS.some((shortcut) => shortcut === value)
}

export function getChatInputSendShortcutLabel(value?: unknown): string {
    const shortcut = isChatInputSendShortcut(value) ? value : DEFAULT_CHAT_INPUT_SEND_SHORTCUT
    return CHAT_INPUT_SEND_SHORTCUT_LABELS[shortcut]
}
