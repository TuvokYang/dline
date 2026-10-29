import { markExpectedCancellation } from "@shared/errors/expected-cancellation"

/** Expected lifecycle cancellation for an interaction waiter or continuation. */
export class InteractionCancellationError extends Error {
    constructor(public readonly reason: string) {
        super(reason)
        this.name = "InteractionCancellationError"
    }
}
markExpectedCancellation(InteractionCancellationError)

/** Return whether an unknown failure represents expected interaction cancellation. */
export function isInteractionCancellationError(error: unknown): error is InteractionCancellationError {
    return error instanceof InteractionCancellationError
}
