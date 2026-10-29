import {
    type CompactionReviewDecision,
    type CompactionReviewPort,
    CompactionReviewWithdrawnError,
} from "../executors/compaction/ProductionCompactionAdapter"
import { isInteractionCancellationError } from "../interaction/InteractionCancellationError"
import type { InteractionOutcome, OpenInteractionRequest } from "../interaction/InteractionProtocol"

/** The one capability review needs from whoever owns dialogs. */
export interface CompactionReviewDialogPort {
    open(request: OpenInteractionRequest): Promise<InteractionOutcome>
}

/**
 * Tells a review when it may take the dialog slot.
 *
 * A `/compact` can run beside a round still in flight, and that round may end
 * on a dialog of its own, which the kernel refuses while another one holds the
 * slot. The review therefore waits until no round can still claim the slot:
 * the round is held for this very run, or the task waits for the user.
 */
export interface CompactionReviewSlotPort {
    /** Resolves once the review may open; rejects with the signal's reason when the run stops first. */
    reviewable(compactionId: string, signal: AbortSignal): Promise<void>
}

/**
 * Presents a manually requested summary through the task's `condense` dialog.
 *
 * Condense accepts the summary as shown. Regenerate carries whatever the user
 * typed as feedback for the next attempt, so an empty draft asks for another
 * summary of the same conversation rather than being refused.
 *
 * The dialog is keyed by the compaction attempt and a review counter, so every
 * regenerated summary is a new interaction the user answers separately. It
 * interrupts a dialog that is waiting for the user, such as the completion a
 * `/compact` was typed beside, which comes back once the review is answered.
 */
export class InteractionCompactionReview implements CompactionReviewPort {
    private reviews = 0

    constructor(
        private readonly dialogs: CompactionReviewDialogPort,
        private readonly slot?: CompactionReviewSlotPort,
    ) {}

    async review(input: {
        readonly compactionId: string
        readonly attempt: string
        readonly summary: string
        readonly existingTs?: number
        readonly signal: AbortSignal
    }): Promise<CompactionReviewDecision> {
        if (input.signal.aborted) throw input.signal.reason
        await this.slot?.reviewable(input.compactionId, input.signal)
        if (input.signal.aborted) throw input.signal.reason
        const round = this.reviews++
        const outcome = await this.open({
            // The run's compaction id is the dialog's turn, which is how the kernel
            // finds and retires this review when the run is abandoned.
            turnId: input.compactionId,
            interactionId: `${input.attempt}:review:${round}`,
            kind: "condense",
            presentation: input.summary,
            ...(input.existingTs === undefined ? {} : { existingTs: input.existingTs }),
            placement: "interrupt",
        })
        if (outcome.actionId === "confirm_utility") return { action: "accept" }
        return { action: "regenerate", feedback: outcome.draft?.text?.trim() ?? "" }
    }

    /** A dialog withdrawn by a stop ends the review; it is not a failed one. */
    private async open(request: OpenInteractionRequest): Promise<InteractionOutcome> {
        try {
            return await this.dialogs.open(request)
        } catch (error) {
            if (isInteractionCancellationError(error)) throw new CompactionReviewWithdrawnError(error.reason)
            throw error
        }
    }
}
