import type { JournalEntry, JournalProjection, JournalWatermark } from "./contracts"

export function compareJournalWatermarks(left: JournalWatermark, right: JournalWatermark): number {
	return left.seq - right.seq
}

export function journalWatermarkKey(watermark: JournalWatermark): string {
	return String(watermark.seq)
}

export function maxJournalWatermark(left: JournalWatermark, right: JournalWatermark): JournalWatermark {
	return compareJournalWatermarks(left, right) >= 0 ? left : right
}

function assertValidSequence(entries: readonly JournalEntry[]): void {
	let previous: JournalEntry | undefined
	for (const entry of entries) {
		if (!Number.isInteger(entry.watermark.seq) || entry.watermark.seq < 1) throw new Error("InvalidJournalSequence")
		const expected = previous ? previous.watermark.seq + 1 : 1
		if (entry.watermark.seq !== expected) throw new Error(previous ? "JournalSequenceGap" : "InvalidJournalGenesis")
		previous = entry
	}
}

/** A shown replacement, with the span it stands for and the originals it hides. */
interface Replacement {
	readonly from: JournalWatermark
	readonly to: JournalWatermark
	readonly hidden: readonly JournalEntry[]
}

type VisibleMessages = Map<string, JournalEntry>
type Replacements = Map<string, Replacement>

function reorder(visible: VisibleMessages): void {
	const ordered = [...visible.values()].sort((left, right) => compareJournalWatermarks(left.watermark, right.watermark))
	visible.clear()
	for (const message of ordered) visible.set(journalWatermarkKey(message.watermark), message)
}

function within(watermark: JournalWatermark, from: JournalWatermark, to: JournalWatermark): boolean {
	return compareJournalWatermarks(watermark, from) >= 0 && compareJournalWatermarks(watermark, to) <= 0
}

/**
 * Hide every visible message in `[from, to]` and return the originals behind them.
 *
 * A replacement the range touches is hidden whole and contributes the
 * originals it stood for, so a later summary always knows exactly which
 * journal messages it replaces, however many summaries preceded it.
 */
function hideRange(visible: VisibleMessages, replacements: Replacements, from: JournalWatermark, to: JournalWatermark) {
	const hidden: JournalEntry[] = []
	for (const [key, message] of visible) {
		const replaced = replacements.get(key)
		const touched = replaced
			? compareJournalWatermarks(replaced.from, to) <= 0 && compareJournalWatermarks(replaced.to, from) >= 0
			: within(message.watermark, from, to)
		if (!touched) continue
		visible.delete(key)
		if (!replaced) {
			hidden.push(message)
			continue
		}
		replacements.delete(key)
		hidden.push(...replaced.hidden)
	}
	return hidden
}

/**
 * Show a supersede marker's replacement where the span it hides began.
 *
 * Taking the span's first watermark keeps the projection in journal order, so
 * input that arrived after the span stays after its replacement and a later
 * range can still address the replacement by position.
 */
function placeReplacement(visible: VisibleMessages, replacements: Replacements, marker: JournalEntry, hidden: JournalEntry[]) {
	if (!marker.range) return
	const replacement: JournalEntry = { ...marker, kind: "message", source: "system", watermark: marker.range.from }
	const key = journalWatermarkKey(marker.range.from)
	visible.set(key, replacement)
	replacements.set(key, { from: marker.range.from, to: marker.range.to, hidden })
	reorder(visible)
}

/**
 * Put back the originals of every replacement that an undo reaches into.
 *
 * A summary speaks for its whole span. Once a tombstone or truncation removes
 * part of that span, the summary would keep saying what was undone, so the
 * replacement gives way to the originals it hid and the undo applies to them.
 */
function unfoldReplacements(
	visible: VisibleMessages,
	replacements: Replacements,
	reaches: (replacement: Replacement) => boolean,
): void {
	for (const [key, replacement] of replacements) {
		if (!reaches(replacement)) continue
		visible.delete(key)
		replacements.delete(key)
		for (const original of replacement.hidden) visible.set(journalWatermarkKey(original.watermark), original)
	}
	reorder(visible)
}

function requireSeen(seen: ReadonlySet<string>, watermark: JournalWatermark): void {
	if (!seen.has(journalWatermarkKey(watermark))) throw new Error("JournalMarkerTargetMissing")
}

/** The projection being built; a rewind replaces its message view wholesale. */
interface ProjectionState {
	visible: VisibleMessages
	replacements: Replacements
	seen: Set<string>
	readonly checkpoints: JournalEntry[]
}

function requireTarget(entry: JournalEntry): JournalWatermark {
	if (!entry.target) throw new Error("JournalMarkerTargetMissing")
	return entry.target
}

function applyTruncation(state: ProjectionState, target: JournalWatermark): void {
	// A boundary on a span's last message keeps the whole span, so its summary stays.
	unfoldReplacements(
		state.visible,
		state.replacements,
		(replacement) =>
			compareJournalWatermarks(target, replacement.from) >= 0 && compareJournalWatermarks(target, replacement.to) < 0,
	)
	for (const [messageKey, message] of state.visible) {
		if (compareJournalWatermarks(message.watermark, target) > 0) {
			state.visible.delete(messageKey)
			state.replacements.delete(messageKey)
		}
	}
}

function applySupersede(state: ProjectionState, entry: JournalEntry): void {
	if (!entry.range) throw new Error("JournalMarkerRangeMissing")
	requireSeen(state.seen, entry.range.from)
	requireSeen(state.seen, entry.range.to)
	if (compareJournalWatermarks(entry.range.from, entry.range.to) > 0) throw new Error("JournalMarkerRangeReversed")
	const hidden = hideRange(state.visible, state.replacements, entry.range.from, entry.range.to)
	if (entry.payloadRef) placeReplacement(state.visible, state.replacements, entry, hidden)
}

/**
 * Return the view to what it was right after `target`.
 *
 * The prefix is projected again from scratch, so everything recorded after the
 * target, summaries included, stops being visible and stops being addressable
 * by later markers. Checkpoint markers are history, not view, and stay.
 */
function applyRewind(state: ProjectionState, target: JournalWatermark, earlier: readonly JournalEntry[]): void {
	requireSeen(state.seen, target)
	const restored = projectEntries(earlier.filter((entry) => compareJournalWatermarks(entry.watermark, target) <= 0))
	state.visible = restored.visible
	state.replacements = restored.replacements
	state.seen = restored.seen
}

function applyEntry(state: ProjectionState, entry: JournalEntry, earlier: () => readonly JournalEntry[]): void {
	switch (entry.kind) {
		case "message":
			state.visible.set(journalWatermarkKey(entry.watermark), entry)
			return
		case "tombstone": {
			const target = requireTarget(entry)
			requireSeen(state.seen, target)
			unfoldReplacements(state.visible, state.replacements, (replacement) =>
				within(target, replacement.from, replacement.to),
			)
			state.visible.delete(journalWatermarkKey(target))
			return
		}
		case "truncate_boundary": {
			const target = requireTarget(entry)
			requireSeen(state.seen, target)
			applyTruncation(state, target)
			return
		}
		case "supersede_range":
			applySupersede(state, entry)
			return
		case "rewind":
			applyRewind(state, requireTarget(entry), earlier())
			return
		case "checkpoint_marker":
			state.checkpoints.push(entry)
			return
	}
}

function projectEntries(entries: readonly JournalEntry[]): ProjectionState {
	const state: ProjectionState = { visible: new Map(), replacements: new Map(), seen: new Set(), checkpoints: [] }
	entries.forEach((entry, index) => {
		applyEntry(state, entry, () => entries.slice(0, index))
		state.seen.add(journalWatermarkKey(entry.watermark))
	})
	return state
}

export function rebuildJournalProjection(
	entries: readonly JournalEntry[],
	through: JournalWatermark = entries.at(-1)?.watermark ?? { seq: 0 },
): JournalProjection {
	assertValidSequence(entries)
	const bounded = entries.filter((entry) => compareJournalWatermarks(entry.watermark, through) <= 0)
	const state = projectEntries(bounded)
	return { through, visibleMessages: [...state.visible.values()], checkpointMarkers: state.checkpoints }
}
