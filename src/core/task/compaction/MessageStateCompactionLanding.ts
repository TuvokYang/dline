import type { UiSayTool } from "@shared/ExtensionMessage"
import type { MessageStateHandler } from "../message-state"
import type { PresentationIdSequence } from "../session/PresentationIdSequence"
import type { CompactionLandingPort, CompactionSummary } from "./CompactionSummaryLanding"

/**
 * Shows a finished summary as the card the user reads and restores from.
 *
 * The provider conversation is condensed by the journal landing that runs
 * before this one; this landing only records the fact in the chat. It does
 * not rewrite the legacy API history rows: the Task runtime never sends them,
 * so rewriting them would only destroy the pre-compaction record a Restore
 * is meant to return to.
 *
 * The card carries the last journal entry the summary replaced. That
 * watermark, not an API row index, is what a Restore from the card rewinds
 * the conversation to.
 */
export class MessageStateCompactionLanding implements CompactionLandingPort {
	/**
	 * @param nextPresentationId The task's shared row-ordering sequence. The card
	 * must draw from it like every other producer: `addToClineMessages` rejects a
	 * message without a `ts`, and a private clock reading would sort the card
	 * against rows the provider service already stamped from the sequence.
	 */
	constructor(
		private readonly messages: MessageStateHandler,
		private readonly nextPresentationId: PresentationIdSequence,
	) {}

	async land(input: { readonly compactionId: string; readonly attempt: string } & CompactionSummary): Promise<void> {
		await this.messages.addToClineMessages({
			ts: this.nextPresentationId(),
			type: "say",
			say: "tool",
			partial: false,
			text: JSON.stringify({
				tool: "summarizeTask",
				content: input.summary,
				compactionStatus: "completed",
				compactionOperationId: input.compactionId,
				compactionUnitKind: "pass",
				compactionDurable: true,
				...(input.span ? { compactionJournalBoundary: { seq: input.span.to.seq } } : {}),
			} satisfies UiSayTool),
		})
	}
}
