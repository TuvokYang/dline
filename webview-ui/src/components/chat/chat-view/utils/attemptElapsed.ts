import type { UiMessage } from "@shared/ExtensionMessage"

/**
 * A row that carries the user's own words: the opening task prompt or a reply
 * the user sent while the task was running.
 */
function startsUserTurn(message: UiMessage): boolean {
    return message.type === "say" && (message.say === "task" || message.say === "user_feedback")
}

/** Intervals this short are noise from a prompt that was already answering, not a turn. */
const MIN_ELAPSED_MS = 1_000

const MINUTE_MS = 60_000

/**
 * How long the attempt that completed at `attemptTs` took, counted from the
 * user input that started it.
 *
 * The attempt starts at the newest user input before the completion, so a
 * second attempt measures its own turn rather than inheriting the first one.
 * `undefined` means the interval is unknown: no user input precedes it, or the
 * two events are too close to be a real waiting period.
 */
export function attemptElapsedMs(messages: readonly UiMessage[], attemptTs: number): number | undefined {
    // A restored or merged window is not guaranteed to arrive in timestamp
    // order, so the newest qualifying input is selected by comparison rather
    // than by stopping at the first one that is late.
    let startedAt: number | undefined
    for (const message of messages) {
        if (message.ts >= attemptTs) continue
        if (!startsUserTurn(message)) continue
        if (startedAt === undefined || message.ts > startedAt) startedAt = message.ts
    }
    if (startedAt === undefined) return undefined
    const elapsed = attemptTs - startedAt
    return elapsed >= MIN_ELAPSED_MS ? elapsed : undefined
}

/**
 * Formats an interval for a row title, keeping the two coarsest units that are
 * non-zero: seconds under a minute, then minutes, then hours with minutes.
 */
export function formatElapsedDuration(elapsedMs: number): string {
    const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000))
    if (totalSeconds < 60) return `${totalSeconds}s`

    const totalMinutes = Math.floor(totalSeconds / 60)
    if (totalMinutes < 60) {
        const seconds = totalSeconds % 60
        return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m ${seconds}s`
    }

    const hours = Math.floor(totalMinutes / 60)
    const minutes = totalMinutes % 60
    return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`
}
