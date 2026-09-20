import type { JournalEntry, JournalProjection, JournalWatermark } from "./contracts"

export function compareJournalWatermarks(left: JournalWatermark, right: JournalWatermark): number {
	return left.epoch === right.epoch ? left.seq - right.seq : left.epoch - right.epoch
}

export function journalWatermarkKey(watermark: JournalWatermark): string {
	return `${watermark.epoch}:${watermark.seq}`
}

export function maxJournalWatermark(left: JournalWatermark, right: JournalWatermark): JournalWatermark {
	return compareJournalWatermarks(left, right) >= 0 ? left : right
}

function assertValidSequence(entries: readonly JournalEntry[]): void {
	let previous: JournalEntry | undefined
	for (const entry of entries) {
		if (!Number.isInteger(entry.watermark.epoch) || entry.watermark.epoch < 0) throw new Error("InvalidJournalEpoch")
		if (!Number.isInteger(entry.watermark.seq) || entry.watermark.seq < 1) throw new Error("InvalidJournalSequence")
		if (!previous) {
			if (entry.watermark.epoch === 0 && entry.watermark.seq === 1) {
				previous = entry
				continue
			}
			if (entry.kind !== "rebase" || entry.watermark.seq !== 1) throw new Error("InvalidJournalGenesis")
			previous = entry
			continue
		}
		if (entry.watermark.epoch === previous.watermark.epoch) {
			if (entry.watermark.seq !== previous.watermark.seq + 1) throw new Error("JournalSequenceGap")
		} else {
			if (entry.watermark.epoch !== previous.watermark.epoch + 1 || entry.watermark.seq !== 1 || entry.kind !== "rebase")
				throw new Error("InvalidJournalRebase")
			if (!entry.previousTail || compareJournalWatermarks(entry.previousTail, previous.watermark) !== 0)
				throw new Error("JournalRebaseTailMismatch")
		}
		previous = entry
	}
}

function requireSeen(seen: ReadonlySet<string>, watermark: JournalWatermark): void {
	if (!seen.has(journalWatermarkKey(watermark))) throw new Error("JournalMarkerTargetMissing")
}

export function rebuildJournalProjection(
	entries: readonly JournalEntry[],
	through: JournalWatermark = entries.at(-1)?.watermark ?? { epoch: 0, seq: 0 },
): JournalProjection {
	assertValidSequence(entries)
	const bounded = entries.filter((entry) => compareJournalWatermarks(entry.watermark, through) <= 0)
	const visible = new Map<string, JournalEntry>()
	const checkpoints: JournalEntry[] = []
	const seen = new Set<string>()

	for (const entry of bounded) {
		const key = journalWatermarkKey(entry.watermark)
		if (entry.kind === "message") visible.set(key, entry)
		if (entry.kind === "tombstone") {
			if (!entry.target) throw new Error("JournalMarkerTargetMissing")
			requireSeen(seen, entry.target)
			visible.delete(journalWatermarkKey(entry.target))
		}
		if (entry.kind === "truncate_boundary") {
			if (!entry.target) throw new Error("JournalMarkerTargetMissing")
			requireSeen(seen, entry.target)
			for (const [messageKey, message] of visible) {
				if (compareJournalWatermarks(message.watermark, entry.target) > 0) visible.delete(messageKey)
			}
		}
		if (entry.kind === "supersede_range") {
			if (!entry.range) throw new Error("JournalMarkerRangeMissing")
			requireSeen(seen, entry.range.from)
			requireSeen(seen, entry.range.to)
			if (compareJournalWatermarks(entry.range.from, entry.range.to) > 0) throw new Error("JournalMarkerRangeReversed")
			for (const [messageKey, message] of visible) {
				if (
					compareJournalWatermarks(message.watermark, entry.range.from) >= 0 &&
					compareJournalWatermarks(message.watermark, entry.range.to) <= 0
				)
					visible.delete(messageKey)
			}
		}
		if (entry.kind === "checkpoint_marker") checkpoints.push(entry)
		seen.add(key)
	}

	return { through, visibleMessages: [...visible.values()], checkpointMarkers: checkpoints }
}
