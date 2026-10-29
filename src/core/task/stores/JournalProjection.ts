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

function emptyProjectionState(): ProjectionState {
    return { visible: new Map(), replacements: new Map(), seen: new Set(), checkpoints: [] }
}

function cloneProjectionState(state: ProjectionState): ProjectionState {
    return {
        visible: new Map(state.visible),
        replacements: new Map(state.replacements),
        seen: new Set(state.seen),
        checkpoints: [...state.checkpoints],
    }
}

function projectionOf(state: ProjectionState, through: JournalWatermark): JournalProjection {
    return { through, visibleMessages: [...state.visible.values()], checkpointMarkers: [...state.checkpoints] }
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

/** The position before the first entry: a rewind to it empties the conversation. */
const JOURNAL_GENESIS: JournalWatermark = { seq: 0 }

/**
 * Return the view to what it was right after `target`.
 *
 * The prefix is projected again from scratch, so everything recorded after the
 * target, summaries included, stops being visible and stops being addressable
 * by later markers. Checkpoint markers are history, not view, and stay.
 * The genesis position is always reachable, so a restore can return to a
 * conversation that has not started yet.
 */
function applyRewind(state: ProjectionState, target: JournalWatermark, restore: () => ProjectionState): void {
    if (compareJournalWatermarks(target, JOURNAL_GENESIS) !== 0) requireSeen(state.seen, target)
    const restored = restore()
    state.visible = restored.visible
    state.replacements = restored.replacements
    state.seen = restored.seen
}

function applyEntry(state: ProjectionState, entry: JournalEntry, restore: (target: JournalWatermark) => ProjectionState): void {
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
        case "rewind": {
            const target = requireTarget(entry)
            applyRewind(state, target, () => restore(target))
            return
        }
        case "checkpoint_marker":
            state.checkpoints.push(entry)
            return
    }
}

function projectEntries(entries: readonly JournalEntry[]): ProjectionState {
    const state = emptyProjectionState()
    entries.forEach((entry, index) => {
        applyEntry(state, entry, (target) =>
            projectEntries(
                entries.slice(0, index).filter((candidate) => compareJournalWatermarks(candidate.watermark, target) <= 0),
            ),
        )
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
    return projectionOf(projectEntries(bounded), through)
}

export interface JournalProjectionIndexOptions {
    readonly checkpointInterval?: number
    readonly historicalCacheSize?: number
}

/** Incremental, rebuildable projection of one append-only conversation journal. */
export class JournalProjectionIndex {
    private readonly entries: JournalEntry[] = []
    private readonly checkpoints = new Map<number, ProjectionState>([[0, emptyProjectionState()]])
    private readonly historical = new Map<number, JournalProjection>()
    private readonly checkpointInterval: number
    private readonly historicalCacheSize: number
    private latestState = emptyProjectionState()
    private latestProjection: JournalProjection = projectionOf(this.latestState, JOURNAL_GENESIS)
    private lastReplayEntries = 0

    constructor(entries: readonly JournalEntry[] = [], options: JournalProjectionIndexOptions = {}) {
        this.checkpointInterval = Math.max(1, options.checkpointInterval ?? 1_024)
        this.historicalCacheSize = Math.max(1, options.historicalCacheSize ?? 16)
        assertValidSequence(entries)
        for (const entry of entries) this.append(entry)
    }

    append(entry: JournalEntry): void {
        const expected = this.entries.length + 1
        if (entry.watermark.seq !== expected) throw new Error(expected === 1 ? "InvalidJournalGenesis" : "JournalSequenceGap")
        this.entries.push(entry)
        applyEntry(this.latestState, entry, (target) => this.stateAt(target.seq))
        this.latestState.seen.add(journalWatermarkKey(entry.watermark))
        this.latestProjection = projectionOf(this.latestState, entry.watermark)
        if (entry.watermark.seq % this.checkpointInterval === 0 || entry.kind === "rewind") {
            this.checkpoints.set(entry.watermark.seq, cloneProjectionState(this.latestState))
        }
    }

    project(through: JournalWatermark = this.latestProjection.through): JournalProjection {
        const tail = this.entries.length
        const seq = Math.min(Math.max(0, through.seq), tail)
        if (seq === tail) {
            return through.seq === tail ? this.latestProjection : { ...this.latestProjection, through }
        }
        const cached = this.historical.get(seq)
        if (cached) {
            this.historical.delete(seq)
            this.historical.set(seq, cached)
            this.lastReplayEntries = 0
            return cached
        }
        const projected = projectionOf(this.stateAt(seq), { seq })
        this.historical.set(seq, projected)
        while (this.historical.size > this.historicalCacheSize) this.historical.delete(this.historical.keys().next().value!)
        return projected
    }

    diagnostics(): { readonly lastReplayEntries: number } {
        return { lastReplayEntries: this.lastReplayEntries }
    }

    private stateAt(targetSeq: number): ProjectionState {
        let checkpointSeq = 0
        for (const seq of this.checkpoints.keys()) {
            if (seq <= targetSeq && seq >= checkpointSeq) checkpointSeq = seq
        }
        const state = cloneProjectionState(this.checkpoints.get(checkpointSeq) ?? emptyProjectionState())
        let replayed = 0
        for (let seq = checkpointSeq + 1; seq <= targetSeq; seq++) {
            const entry = this.entries[seq - 1]
            if (!entry) break
            applyEntry(state, entry, (target) => this.stateAt(target.seq))
            state.seen.add(journalWatermarkKey(entry.watermark))
            replayed++
        }
        this.lastReplayEntries = replayed
        return state
    }
}
