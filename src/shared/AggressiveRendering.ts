/**
 * How aggressively the chat folds a turn's activity rows into expandable blocks.
 *
 * Folding follows the running task: a request round folds once it has ended,
 * while the round still running stays drawn as it is.
 *
 * - `standard`: today's rendering; nothing is folded.
 * - `activity`: each request round folds into its own block when it ends.
 * - `turn`: the ended rounds between a user message and the turn's end fold into
 *   one block, which takes in each further round as it ends.
 *
 * The stored values are a persisted contract; only the labels describe them.
 */
export const AGGRESSIVE_RENDERING_LEVELS = ["standard", "activity", "turn"] as const

export type AggressiveRenderingLevel = (typeof AGGRESSIVE_RENDERING_LEVELS)[number]

export const DEFAULT_AGGRESSIVE_RENDERING: AggressiveRenderingLevel = "standard"

export const AGGRESSIVE_RENDERING_LABELS: Record<AggressiveRenderingLevel, string> = {
    standard: "Standard (no folding)",
    activity: "Fold each round when it ends",
    turn: "Fold the whole turn into one block",
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
    return isAggressiveRenderingLevel(value) ? value : DEFAULT_AGGRESSIVE_RENDERING
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
 * while it is off the chat renders at `standard`, and the stored choice is kept for
 * when the flag turns on again.
 */
export function effectiveAggressiveRendering(setting: Partial<AggressiveRenderingSetting> | undefined): AggressiveRenderingLevel {
    if (!setting?.featureFlag) return DEFAULT_AGGRESSIVE_RENDERING
    return normalizeAggressiveRenderingLevel(setting.user)
}
