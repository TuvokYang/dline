import type { ConversationJournal, JournalWatermark } from "./contracts"
import { compareJournalWatermarks, journalWatermarkKey } from "./JournalProjection"

/**
 * Rewinds a task's conversation journal on behalf of a checkpoint restore.
 *
 * The rewind record is the restore's commit point, so everything that could
 * make it unreadable is checked before it is written. A rewind the projection
 * cannot apply - a target past the tail, or one that names no entry - would
 * not fail the restore; it would make every later projection of the task
 * throw, which loses the whole conversation instead of shortening it.
 */
export class JournalConversationRewind {
	constructor(private readonly journal: ConversationJournal) {}

	async rewindTo(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<void> {
		// A restore retried after a crash replays its own record instead of
		// stacking a second rewind on top of it.
		const existing = await this.journal.findByOperation(input.operationId)
		if (existing) {
			// Only an exact replay is a success; the same operation naming another
			// record or another target would report a conversation it never made.
			const sameTarget =
				existing.target !== undefined && journalWatermarkKey(existing.target) === journalWatermarkKey(input.target)
			if (existing.kind !== "rewind" || !sameTarget) throw new Error("ConversationRewindOperationConflict")
			return
		}
		if (compareJournalWatermarks(input.target, this.journal.watermark()) > 0) {
			throw new Error("ConversationRewindTargetAhead")
		}
		const entries = await this.journal.read(undefined, input.target)
		const key = journalWatermarkKey(input.target)
		if (!entries.some((entry) => journalWatermarkKey(entry.watermark) === key)) {
			throw new Error("ConversationRewindTargetMissing")
		}
		await this.journal.rewind({ operationId: input.operationId, target: input.target })
	}
}
