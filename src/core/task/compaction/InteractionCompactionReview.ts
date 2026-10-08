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
 * Presents a manually requested summary through the task's `condense` dialog.
 *
 * Condense accepts the summary as shown. Regenerate carries whatever the user
 * typed as feedback for the next attempt, so an empty draft asks for another
 * summary of the same conversation rather than being refused.
 *
 * The dialog is keyed by the compaction attempt and a review counter, so every
 * regenerated summary is a new interaction the user answers separately.
 */
export class InteractionCompactionReview implements CompactionReviewPort {
	private reviews = 0

	constructor(private readonly dialogs: CompactionReviewDialogPort) {}

	async review(input: {
		readonly compactionId: string
		readonly attempt: string
		readonly summary: string
		readonly signal: AbortSignal
	}): Promise<CompactionReviewDecision> {
		if (input.signal.aborted) throw input.signal.reason
		const round = this.reviews++
		const outcome = await this.open({
			// The run's compaction id is the dialog's turn, which is how the kernel
			// finds and retires this review when the run is abandoned.
			turnId: input.compactionId,
			interactionId: `${input.attempt}:review:${round}`,
			kind: "condense",
			presentation: input.summary,
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
