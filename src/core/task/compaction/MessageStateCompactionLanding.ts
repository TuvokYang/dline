import type { UiSayTool } from "@shared/ExtensionMessage"
import type { CompactionLandingInput, CompactionLandingPort } from "./CompactionSummaryLanding"
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
 * Chat Restore normally belongs to the checkpoint row written before the
 * rewrite. Only when that row could not be established does the card carry
 * the last replaced journal entry as a fallback restore boundary.
 */
export class MessageStateCompactionLanding implements CompactionLandingPort {
    /** @param cards Writes the card in place of the run's progress card, or as a new row when it showed none. */
    constructor(private readonly cards: CompactionRecordPort) {}

    async land(input: CompactionLandingInput): Promise<void> {
        // The completed card is the presentation commit point. A cancellation that
        // won before this point leaves no durable completed card behind.
        if (input.signal?.aborted) throw input.signal.reason
        await this.cards.record(input.compactionId, {
            tool: "summarizeTask",
            content: input.summary,
            compactionStatus: "completed",
            compactionOperationId: input.compactionId,
            compactionUnitKind: "pass",
            compactionDurable: true,
            ...(input.span && input.restoreDisposition !== "checkpoint_row"
                ? { compactionJournalBoundary: { seq: input.span.to.seq } }
                : {}),
        } satisfies UiSayTool)
    }
}
