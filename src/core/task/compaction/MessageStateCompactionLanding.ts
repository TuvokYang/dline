import type { UiSayTool } from "@shared/ExtensionMessage"
import type { CompactionLandingPort, CompactionSummary } from "./CompactionSummaryLanding"
import type { CompactionRecordPort } from "./MessageStateCompactionCards"

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
	/** @param cards Writes the card in place of the run's progress card, or as a new row when it showed none. */
	constructor(private readonly cards: CompactionRecordPort) {}

	async land(input: { readonly compactionId: string; readonly attempt: string } & CompactionSummary): Promise<void> {
		await this.cards.record(input.compactionId, {
			tool: "summarizeTask",
			content: input.summary,
			compactionStatus: "completed",
			compactionOperationId: input.compactionId,
			compactionUnitKind: "pass",
			compactionDurable: true,
			...(input.span ? { compactionJournalBoundary: { seq: input.span.to.seq } } : {}),
		} satisfies UiSayTool)
	}
}
