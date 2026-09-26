import type { ConversationJournal, JournalEntry, JournalSource, JournalWatermark } from "./contracts"
import { compareJournalWatermarks, journalWatermarkKey, rebuildJournalProjection } from "./JournalProjection"

/** The position before the first entry; rewinding to it empties the conversation. */
const GENESIS: JournalWatermark = { seq: 0 }

/** Sources of entries that carry something the user said. */
const INPUT_SOURCES: ReadonlySet<JournalSource> = new Set(["intake", "dialog"])

/** Finds where a conversation of a given length stood, for rows that recorded only a length. */
export interface ConversationLengthIndex {
	positionKeeping(keep: number): Promise<JournalWatermark | undefined>
}

/**
 * Where a chat row says the conversation stood when the row was written.
 *
 * `seq` is the journal position the row recorded. A row written before rows
 * recorded it carries only `keep`, how many messages the conversation held;
 * a length stops naming one position once the conversation was compacted, so
 * it is only the fallback.
 */
export interface ConversationRowPosition {
	readonly keep: number
	readonly seq?: number
	/**
	 * The row shows user input that is journaled right after the row. Keeping
	 * the row keeps that input; an edit, which submits new input, does not.
	 */
	readonly keepInput?: boolean
}

function isToolResult(entry: JournalEntry): boolean {
	return entry.source === "tool"
}

function isInput(entry: JournalEntry): boolean {
	return entry.source !== undefined && INPUT_SOURCES.has(entry.source)
}

/**
 * Rewinds a task's conversation journal on behalf of a checkpoint restore.
 *
 * The rewind record is the restore's commit point, so everything that could
 * make it unreadable is checked before it is written. A rewind the projection
 * cannot apply - a target past the tail, or one an earlier rewind already
 * undid - would not fail the restore; it would make every later projection of
 * the task throw, which loses the whole conversation instead of shortening it.
 */
export class JournalConversationRewind {
	constructor(
		private readonly journal: ConversationJournal,
		private readonly lengths?: ConversationLengthIndex,
	) {}

	/** Whether the journal holds this task's conversation; a task that predates it keeps its legacy rows. */
	holdsConversation(): boolean {
		return compareJournalWatermarks(this.journal.watermark(), GENESIS) > 0
	}

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
		const tail = this.journal.watermark()
		if (compareJournalWatermarks(input.target, tail) > 0) throw new Error("ConversationRewindTargetAhead")
		await this.assertProjectable(input.operationId, input.target, tail)
		await this.journal.rewind({ operationId: input.operationId, target: input.target })
	}

	/**
	 * Return the conversation to where it stood when a chat row was written.
	 *
	 * Tool results that follow that point are kept: a row can be written while
	 * its tool still runs, and dropping the result would leave the kept tool
	 * call unanswered, which providers reject. Anything else recorded later, a
	 * summary or an input being edited included, is undone.
	 *
	 * The record is named by the restore and the tail it found, so restoring the
	 * same row again after the conversation moved on undoes what was said since,
	 * while a retry of a restore that already landed writes nothing.
	 */
	async rewindToRow(input: { readonly operationId: string; readonly row: ConversationRowPosition }): Promise<void> {
		const tail = this.journal.watermark()
		const base = await this.positionOf(input.row)
		// The conversation never grew to the row's length, so nothing was said after it.
		if (!base) return
		if (compareJournalWatermarks(base, tail) > 0) throw new Error("ConversationRewindTargetAhead")
		const target = await this.extendPast(base, input.row.keepInput === true)
		if (compareJournalWatermarks(target, tail) === 0) return
		if (await this.endsWithRewindTo(target)) return
		await this.rewindTo({ operationId: `${input.operationId}@${tail.seq}`, target })
	}

	private async positionOf(row: ConversationRowPosition): Promise<JournalWatermark | undefined> {
		if (row.seq !== undefined) return { seq: row.seq }
		if (row.keep <= 0) return GENESIS
		if (!this.lengths) throw new Error("ConversationRewindLengthUnavailable")
		return this.lengths.positionKeeping(row.keep)
	}

	/**
	 * Extend `base` over what still belongs to the row: its own input when it
	 * follows immediately, then the tool results answering the calls it keeps.
	 * Only the current view is walked, so an entry an earlier rewind undid is
	 * never picked up again.
	 */
	private async extendPast(base: JournalWatermark, keepInput: boolean): Promise<JournalWatermark> {
		const later = (await this.journal.project()).visibleMessages.filter(
			(entry) => compareJournalWatermarks(entry.watermark, base) > 0,
		)
		let target = base
		let index = 0
		if (keepInput && later[0] && isInput(later[0])) target = later[index++].watermark
		for (; index < later.length && isToolResult(later[index]); index++) target = later[index].watermark
		return target
	}

	/** Whether the latest record already returned the conversation to `target`. */
	private async endsWithRewindTo(target: JournalWatermark): Promise<boolean> {
		const tail = this.journal.watermark()
		if (compareJournalWatermarks(tail, GENESIS) === 0) return false
		const [latest] = await this.journal.read({ seq: tail.seq - 1 })
		return (
			latest?.kind === "rewind" &&
			latest.target !== undefined &&
			journalWatermarkKey(latest.target) === journalWatermarkKey(target)
		)
	}

	/** Project the journal as it would read with the rewind recorded, without recording it. */
	private async assertProjectable(operationId: string, target: JournalWatermark, tail: JournalWatermark): Promise<void> {
		const record: JournalEntry = { version: 1, watermark: { seq: tail.seq + 1 }, operationId, kind: "rewind", target }
		try {
			rebuildJournalProjection([...(await this.journal.read()), record])
		} catch {
			throw new Error("ConversationRewindTargetMissing")
		}
	}
}
