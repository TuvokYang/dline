import type { UiMessage } from "@shared/ExtensionMessage"

/** The chat surface that owns command rows and can patch one in place. */
export interface CommandRowSurface {
    readonly clineMessages: readonly UiMessage[]
    updateClineMessage(index: number, updates: Partial<UiMessage>): Promise<void>
}

/** A command row still showing work whose activity was found interrupted. */
export function isInterruptedCommandRow(message: UiMessage, activityIds: ReadonlySet<string>): boolean {
    return (
        message.activityId !== undefined &&
        activityIds.has(message.activityId) &&
        (message.commandStatus === "pending" || message.commandStatus === "running")
    )
}

/**
 * Settle the command rows of interrupted activities.
 *
 * The row is what the chat draws, so a row left running keeps offering Cancel
 * for a process nobody owns even after its activity was settled.
 *
 * @param surface Chat rows of the task, patched in place.
 * @param activityIds Activities that were settled as interrupted.
 * @returns Number of rows that were settled.
 */
export async function settleInterruptedCommandRows(
    surface: CommandRowSurface,
    activityIds: ReadonlySet<string>,
): Promise<number> {
    if (activityIds.size === 0) return 0
    let settled = 0
    for (const [index, message] of surface.clineMessages.entries()) {
        if (!isInterruptedCommandRow(message, activityIds)) continue
        await surface.updateClineMessage(index, { commandStatus: "interrupted" })
        settled += 1
    }
    return settled
}
