import type { UiSayTool } from "@shared/ExtensionMessage"
import type { CompactionFailurePresentationPort } from "../executors/compaction/ProductionCompactionAdapter"
import type { MessageStateHandler } from "../message-state"
import type { PresentationIdSequence } from "../session/PresentationIdSequence"

/**
 * User-facing text for a compaction that produced nothing to land.
 *
 * The provider's own diagnostic stays in the logs: it can name limits, request
 * details or partial output, none of which the user can act on from the chat.
 */
export const COMPACTION_FAILURE_MESSAGE = "Conversation compaction failed before completion. The conversation was left unchanged."

/**
 * Shows a failed compaction as its own chat row.
 *
 * The row carries no summary - there is none - so it is the standalone failure
 * form of the compaction card rather than a card with an error attached, and a
 * restore that rewinds past it removes it like any other row.
 */
export class MessageStateCompactionFailure implements CompactionFailurePresentationPort {
	/** @param nextPresentationId The task's shared row-ordering sequence; see MessageStateCompactionLanding. */
	constructor(
		private readonly messages: MessageStateHandler,
		private readonly nextPresentationId: PresentationIdSequence,
	) {}

	async present(input: { readonly compactionId: string; readonly attempt: string }): Promise<void> {
		await this.messages.addToClineMessages({
			ts: this.nextPresentationId(),
			type: "say",
			say: "tool",
			partial: false,
			text: JSON.stringify({
				tool: "summarizeTask",
				content: "",
				compactionStatus: "failed",
				compactionOperationId: input.compactionId,
				compactionAttemptId: input.attempt,
				compactionUnitKind: "failure",
				compactionDurable: true,
				error: COMPACTION_FAILURE_MESSAGE,
			} satisfies UiSayTool),
		})
	}
}
