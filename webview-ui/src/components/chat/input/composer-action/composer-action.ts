/**
 * What the composer's action button does right now.
 *
 * - `send`: the task takes input now, so a click sends the draft.
 * - `resume`: the task is paused, so a click resumes it with the draft, which may be empty.
 * - `queue`: the task is busy but will drain the queue, so a click queues the draft.
 * - `cancel`: the task is busy and there is nothing to queue, so a click stops it.
 * - `unavailable`: nothing can take a click; the button only explains why.
 */
export type ComposerAction = "send" | "resume" | "queue" | "cancel" | "unavailable"

/** What a send from the composer does to the task: start a turn, or resume a paused task. */
export type ComposerSubmitKind = "send" | "resume"

export interface ComposerActionState {
    /** The task takes a send now. */
    readonly canSend: boolean
    /** What that send does; `send` when omitted. */
    readonly submitKind?: ComposerSubmitKind
    /** A send the task cannot take now is handed to the queue instead. */
    readonly canQueue: boolean
    /** The running task can be cancelled. */
    readonly canCancel: boolean
    /** The composer holds something to send. */
    readonly hasContent: boolean
}

/** How long the pointer has to rest on the queue button before it offers cancel instead. */
export const CANCEL_REVEAL_HOVER_MS = 3000

/** The action a click performs, before any hover changes it. */
export function resolveComposerAction(state: ComposerActionState): ComposerAction {
    if (state.canSend) return state.submitKind ?? "send"
    if (state.hasContent && state.canQueue) return "queue"
    if (state.canCancel) return "cancel"
    return "unavailable"
}

/**
 * The action a long hover reveals in place of the primary one.
 *
 * Queueing hides cancel while there is a draft to queue; resting on the button
 * brings it back without clearing the draft.
 */
export function hoverRevealedAction(primary: ComposerAction, state: ComposerActionState): ComposerAction | undefined {
    return primary === "queue" && state.canCancel ? "cancel" : undefined
}
