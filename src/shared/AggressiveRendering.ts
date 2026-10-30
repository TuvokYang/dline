/**
 * How aggressively the chat folds a turn's activity rows into expandable blocks.
 *
 * Request completion makes content eligible for folding; it does not split a
 * block. Content from the running request stays drawn as it is.
 *
 * - `none`: standard rows without an additional folding layer.
 * - `message_segment`: finished activity between assistant messages is folded together.
 * - `user_turn`: finished content is folded across assistant messages, within a user turn.
 *
 * Legacy persisted values are normalized on read; new writes use only canonical values.
 */
export const AGGRESSIVE_RENDERING_LEVELS = ["none", "message_segment", "user_turn"] as const

export type AggressiveRenderingLevel = (typeof AGGRESSIVE_RENDERING_LEVELS)[number]

export const DEFAULT_AGGRESSIVE_RENDERING: AggressiveRenderingLevel = "none"

export const AGGRESSIVE_RENDERING_LABELS: Record<AggressiveRenderingLevel, string> = {
    none: "Standard (no folding)",
    message_segment: "Fold activity between messages",
    user_turn: "Fold the whole turn into one block",
}

/**
 * The two facts the extension projects to the webview: the stored user choice and
 * whether the remote rollout currently offers the setting.
 */
export interface AggressiveRenderingSetting {
    user: AggressiveRenderingLevel
    featureFlag: boolean
}

export const DEFAULT_AGGRESSIVE_RENDERING_SETTING: AggressiveRenderingSetting = {
    user: DEFAULT_AGGRESSIVE_RENDERING,
    featureFlag: false,
}

export function isAggressiveRenderingLevel(value: unknown): value is AggressiveRenderingLevel {
    return AGGRESSIVE_RENDERING_LEVELS.some((level) => level === value)
}

/** Reads a stored value; anything that is not a known level reads as the default. */
export function normalizeAggressiveRenderingLevel(value: unknown): AggressiveRenderingLevel {
    if (isAggressiveRenderingLevel(value)) return value
    switch (value) {
        case "standard":
            return "none"
        case "activity":
            return "message_segment"
        case "turn":
            return "user_turn"
        default:
            return DEFAULT_AGGRESSIVE_RENDERING
    }
}

/**
 * The projection the extension sends to the webview. The stored value is normalized
 * and kept whatever the flag says, so turning the rollout off never erases a choice.
 */
export function projectAggressiveRendering(storedValue: unknown, featureFlag: boolean): AggressiveRenderingSetting {
    return { user: normalizeAggressiveRenderingLevel(storedValue), featureFlag }
}

/**
 * The level the chat renders at. The rollout flag only makes the choice available:
 * while it is off the chat renders at `none`, and the stored choice is kept for
 * when the flag turns on again.
 */
export function effectiveAggressiveRendering(setting: Partial<AggressiveRenderingSetting> | undefined): AggressiveRenderingLevel {
    if (!setting?.featureFlag) return DEFAULT_AGGRESSIVE_RENDERING
    return normalizeAggressiveRenderingLevel(setting.user)
}
