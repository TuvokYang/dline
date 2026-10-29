/**
 * Where one send attempt puts the draft.
 *
 * `retain` keeps the draft in the composer. It is not a discard: nothing can
 * carry the draft right now, so it stays where the user can still see and
 * resend it.
 */
export type SendDisposition = "submit" | "enqueue" | "retain"

export interface SendConditions {
    /** Whether the composer can dispatch this draft to the task right now. */
    canSubmit: boolean
    /** Whether a task in this phase still reaches a queue delivery point. */
    queueCanDeliver: boolean
}

/**
 * Decide what happens to one send, for every entry point alike.
 *
 * Submitting is always attempted first; the queue only catches a send that
 * cannot go out. Keeping the decision here is what makes the Enter key, the
 * send button and a resume behave identically instead of each re-deriving it.
 *
 * Every branch returns a disposition that preserves the draft, so no send is
 * ever silently dropped.
 */
export function resolveSendDisposition({ canSubmit, queueCanDeliver }: SendConditions): SendDisposition {
    if (canSubmit) {
        return "submit"
    }
    return queueCanDeliver ? "enqueue" : "retain"
}
