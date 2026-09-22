/**
 * User-authored input retained for later delivery.
 *
 * Entries are never delivered by a state flip: an entry leaves the queue only
 * when a causal delivery path claims it (turn-end for `queued`, the next round
 * for `steering`) or when the user removes it.
 *
 * The entry shape itself lives in `shared` because it crosses to the Webview
 * through ExtensionState; only the queue behaviour belongs to the backend.
 */

import { INPUT_QUEUE_LIMIT, type InputQueueMode, type QueuedInputEntry } from "@shared/InputQueue"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { validateSemanticInputDocument } from "@shared/input-semantics/validation"

export type { InputQueueMode, QueuedInputEntry }
export { INPUT_QUEUE_LIMIT }

/** Draft content captured from the composer. */
export interface InputQueueDraft {
	text: string
	images: readonly string[]
	files: readonly string[]
	activeQuote?: string
	/** The composed structure, retained so delivery never re-parses `text`. */
	semanticInput?: SemanticInputDocument
}

/**
 * Full runtime state of a queue at one point in time.
 *
 * Opaque to callers: it exists only to be handed back to
 * {@link InputQueue.rollback}.
 */
export interface InputQueueCheckpoint {
	readonly entries: QueuedInputEntry[]
	readonly claimedIds: ReadonlySet<string>
	readonly cancelledIds: ReadonlySet<string>
	readonly sequenceCounter: number
}

let nextEntrySequence = 0

function createEntryId(): string {
	nextEntrySequence += 1
	return `queued-input-${Date.now().toString(36)}-${nextEntrySequence.toString(36)}`
}

function normalizeMode(value: unknown): InputQueueMode {
	return value === "steering" ? "steering" : "queued"
}

function normalizeStrings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

/** Whether a persisted entry was handed to a delivery that never settled. */
function wasDelivering(value: unknown): boolean {
	return typeof value === "object" && value !== null && (value as Record<string, unknown>).delivering === true
}

/**
 * Rebuild the retained structure, or report that this entry is text only.
 *
 * A persisted document was written by an older schema or catalog, so it is
 * validated rather than trusted. An undecodable one is dropped instead of
 * failing the entry: the user's text is still deliverable, and keeping a
 * document that no longer validates would let delivery act on a structure the
 * current catalog does not agree with.
 */
function normalizeSemanticInput(value: unknown): SemanticInputDocument | undefined {
	if (!value || typeof value !== "object") return undefined
	const candidate = value as SemanticInputDocument
	return validateSemanticInputDocument(candidate).length === 0 ? candidate : undefined
}

/** Rebuild one entry from untrusted persisted input. */
function normalizeEntry(value: unknown, index: number): QueuedInputEntry | undefined {
	if (!value || typeof value !== "object") return undefined
	const raw = value as Record<string, unknown>
	if (typeof raw.text !== "string") return undefined
	const semanticInput = normalizeSemanticInput(raw.semanticInput)
	return {
		id: typeof raw.id === "string" && raw.id ? raw.id : createEntryId(),
		text: raw.text,
		images: normalizeStrings(raw.images),
		files: normalizeStrings(raw.files),
		...(typeof raw.activeQuote === "string" ? { activeQuote: raw.activeQuote } : {}),
		...(semanticInput === undefined ? {} : { semanticInput }),
		// Every restored document was composed against an earlier catalog
		// revision, so delivery must revalidate before acting on it.
		...(semanticInput === undefined ? {} : { semanticInputStale: true }),
		mode: normalizeMode(raw.mode),
		// A reloaded task has no composer holding the content, so a persisted
		// editing gate would strand the entry permanently. Always clear it.
		sequence: typeof raw.sequence === "number" ? raw.sequence : index,
	}
}

/**
 * Ordered, bounded store of retained user input.
 *
 * Order is user-controlled and carries meaning: `queued` entries are consumed
 * front-to-back, so reordering decides what the next turn-end delivers.
 */
export class InputQueue {
	private entries: QueuedInputEntry[] = []
	private sequenceCounter = 0
	/**
	 * Entries handed to an in-flight delivery.
	 *
	 * A claimed entry stays in `entries` so reordering and renumbering keep
	 * seeing it. Removing it up front is what previously let a concurrent
	 * reorder hand its position to another entry, so a failed delivery came
	 * back in the wrong place.
	 */
	private claimedIds = new Set<string>()
	/**
	 * Ids the user removed while a delivery held them.
	 *
	 * The entry is already gone from `entries`, so this is the only remaining
	 * record that the delivery in progress must not send it.
	 */
	private cancelledIds = new Set<string>()
	/** Entries this load discarded because they were still in flight. */
	private droppedInFlightOnLoad = 0

	/**
	 * Restore a queue from persisted state, dropping anything unusable.
	 *
	 * An over-limit file is kept whole. The limit bounds how much new input may
	 * be added, and everything on disk was already accepted, so truncating here
	 * would delete user input that a reload was only supposed to reinstate.
	 *
	 * Entries marked `delivering` are dropped. The write that would have cleared
	 * the mark never happened, so it is unknown whether the model received them.
	 * Restoring one risks sending the same instruction twice, which can undo
	 * work already done; dropping it is visible to the user, who still has their
	 * own text. At-most-once is the safer default for an instruction.
	 */
	static fromSerialized(value: unknown): InputQueue {
		const queue = new InputQueue()
		queue.resetFrom(value)
		return queue
	}

	/**
	 * Reload persisted state into this queue instead of building a new one.
	 *
	 * A reload can reach a task that is already running, and any delivery in
	 * flight holds a closure over this object. Replacing the instance would
	 * leave that delivery settling a queue nothing else reads, so its entry
	 * could be claimed and sent a second time. Resetting in place keeps every
	 * holder pointed at the one queue that is actually persisted.
	 */
	resetFrom(value: unknown): void {
		this.entries = []
		this.claimedIds.clear()
		this.cancelledIds.clear()
		this.droppedInFlightOnLoad = 0
		this.sequenceCounter = 0
		if (!Array.isArray(value)) return
		const restored: QueuedInputEntry[] = []
		const seenIds = new Set<string>()
		value.forEach((raw, index) => {
			const entry = normalizeEntry(raw, index)
			if (!entry) {
				// Unusable data, not lost input. Counting it as a dropped
				// delivery would report input the user never had.
				return
			}
			if (wasDelivering(raw)) {
				this.droppedInFlightOnLoad += 1
				return
			}
			// A corrupted or hand-edited file can repeat an id. Ids address
			// entries one at a time, so leaving a duplicate in would let a
			// single claim, removal or commit act on someone else's text.
			// Renaming the later one keeps both texts and makes each
			// addressable; dropping either would discard user input.
			const unique = seenIds.has(entry.id) ? { ...entry, id: createEntryId() } : entry
			seenIds.add(unique.id)
			restored.push(unique)
		})
		this.entries = restored
		// Keep future insertions ordered after everything restored from disk.
		this.sequenceCounter = this.entries.reduce((highest, entry) => Math.max(highest, entry.sequence), -1) + 1
	}

	/**
	 * How many entries this load discarded because they were still in flight.
	 *
	 * Reported rather than silently swallowed: the user queued that input and
	 * will not see it again, so the reason has to be recoverable from a log.
	 */
	get droppedInFlightCount(): number {
		return this.droppedInFlightOnLoad
	}

	/**
	 * Capture the full runtime state so a failed write can be undone.
	 *
	 * A user change is only real once it is on disk. When the write fails the
	 * in-memory queue has to go back to what the file still says, otherwise the
	 * user is shown a queue a reload would contradict. Rebuilding from
	 * `fromSerialized` would not do: it drops in-flight entries and forgets the
	 * claim and cancellation state a running delivery depends on.
	 */
	checkpoint(): InputQueueCheckpoint {
		return {
			entries: this.entries.map((entry) => ({ ...entry })),
			claimedIds: new Set(this.claimedIds),
			cancelledIds: new Set(this.cancelledIds),
			sequenceCounter: this.sequenceCounter,
		}
	}

	/** Undo everything done since {@link checkpoint}. */
	rollback(checkpoint: InputQueueCheckpoint): void {
		this.entries = checkpoint.entries.map((entry) => ({ ...entry }))
		this.claimedIds = new Set(checkpoint.claimedIds)
		this.cancelledIds = new Set(checkpoint.cancelledIds)
		this.sequenceCounter = checkpoint.sequenceCounter
	}

	/** Entries the user can still see and act on, in delivery order. */
	list(): readonly QueuedInputEntry[] {
		return this.visible().map((entry) => ({ ...entry }))
	}

	get(id: string): QueuedInputEntry | undefined {
		return this.entries.find((entry) => entry.id === id)
	}

	/**
	 * Look up an entry the user may still act on.
	 *
	 * Mutations resolve ids through this rather than {@link get}: a user request
	 * is asynchronous, so it can arrive after the entry was claimed for delivery.
	 * Applying it then would change an entry whose content is already on its way
	 * to the model, and the change would be discarded when the claim commits.
	 */
	private getMutable(id: string): QueuedInputEntry | undefined {
		const entry = this.get(id)
		return entry && !this.claimedIds.has(entry.id) ? entry : undefined
	}

	/** Number of entries still owned by the user, excluding in-flight ones. */
	get size(): number {
		return this.visible().length
	}

	private visible(): QueuedInputEntry[] {
		return this.entries.filter((entry) => !this.claimedIds.has(entry.id))
	}

	/**
	 * Append one draft as `queued`, or refuse when the queue is full.
	 *
	 * In-flight entries count against the limit because a failed delivery
	 * returns them; ignoring them could push the queue past the limit.
	 */
	enqueue(draft: InputQueueDraft): string | undefined {
		if (this.entries.length >= INPUT_QUEUE_LIMIT) {
			return undefined
		}
		const entry: QueuedInputEntry = {
			id: createEntryId(),
			text: draft.text,
			images: [...draft.images],
			files: [...draft.files],
			...(draft.activeQuote ? { activeQuote: draft.activeQuote } : {}),
			...(draft.semanticInput === undefined ? {} : { semanticInput: draft.semanticInput }),
			mode: "queued",
			sequence: this.sequenceCounter++,
		}
		this.entries.push(entry)
		return entry.id
	}

	/** Switch one entry between `queued` and `steering` without delivering it. */
	toggleMode(id: string): InputQueueMode | undefined {
		const entry = this.getMutable(id)
		if (!entry) return undefined
		const mode: InputQueueMode = entry.mode === "steering" ? "queued" : "steering"
		this.replace(id, { ...entry, mode })
		return mode
	}

	/**
	 * Move one entry to an explicit position, shifting the rest.
	 *
	 * `targetIndex` addresses the list the user can see, which omits in-flight
	 * entries. It is resolved against that list and translated back, so a
	 * delivery in progress cannot shift the drop position.
	 */
	reorder(id: string, targetIndex: number): boolean {
		const from = this.entries.findIndex((entry) => entry.id === id)
		if (from < 0 || this.claimedIds.has(id)) return false
		const visible = this.visible()
		const fromVisible = visible.findIndex((entry) => entry.id === id)
		const to = Math.max(0, Math.min(targetIndex, visible.length - 1))
		const anchor = visible[to]
		if (!anchor || anchor.id === id) return true
		const [moved] = this.entries.splice(from, 1)
		const anchorIndex = this.entries.findIndex((entry) => entry.id === anchor.id)
		// Moving down lands after the anchor, moving up lands before it, which is
		// what a drag onto that row means in either direction.
		this.entries.splice(fromVisible < to ? anchorIndex + 1 : anchorIndex, 0, moved)
		this.resequence()
		return true
	}

	/**
	 * Renumber entries to match their current positions.
	 *
	 * `sequence` is what a failed delivery uses to find its way back, so it has
	 * to follow the order the user last chose. Leaving it at the insertion rank
	 * would make a restore undo their reordering.
	 */
	private resequence(): void {
		this.entries = this.entries.map((entry, index) => ({ ...entry, sequence: index }))
		this.sequenceCounter = this.entries.length
	}

	/** Mark one entry as held by the composer, excluding it from delivery. */
	beginEdit(id: string): QueuedInputEntry | undefined {
		const entry = this.getMutable(id)
		if (!entry) return undefined
		const editing = { ...entry, editing: true }
		this.replace(id, editing)
		return editing
	}

	/** Write edited content back in place, preserving position and mode. */
	commitEdit(id: string, draft: InputQueueDraft): QueuedInputEntry | undefined {
		const entry = this.getMutable(id)
		if (!entry) return undefined
		const updated: QueuedInputEntry = {
			...entry,
			text: draft.text,
			images: [...draft.images],
			files: [...draft.files],
			...(draft.activeQuote ? { activeQuote: draft.activeQuote } : { activeQuote: undefined }),
			// A commit replaces the structure wholesale, so a document the user
			// just recomposed is current again and an edit that dropped it must
			// not leave the previous structure behind.
			semanticInput: draft.semanticInput,
			semanticInputStale: undefined,
			editing: false,
		}
		this.replace(id, updated)
		return updated
	}

	/**
	 * Release the composer hold without changing content.
	 *
	 * @returns whether the entry exists, so a stale id is reported rather than
	 * being reported to the user as a successful cancel.
	 */
	cancelEdit(id: string): boolean {
		const entry = this.getMutable(id)
		if (!entry) return false
		this.replace(id, { ...entry, editing: false })
		return true
	}

	/**
	 * Drop one entry on the user's explicit request, in flight or not.
	 *
	 * Unlike the other mutations this deliberately accepts a claimed entry.
	 * Removal is the user stating they no longer want the input at all, so it
	 * outranks a delivery that has not settled; a later release must not bring
	 * the entry back. Content already staged into a request cannot be recalled,
	 * but {@link isCancelled} lets a delivery that has not sent yet check.
	 */
	remove(id: string): boolean {
		const index = this.entries.findIndex((entry) => entry.id === id)
		if (index < 0) return false
		this.entries.splice(index, 1)
		if (this.claimedIds.delete(id)) {
			// The delivery holding this id is still running and will consult the
			// tombstone before sending.
			this.cancelledIds.add(id)
		}
		return true
	}

	/**
	 * Whether an in-flight entry was removed by the user after being claimed.
	 *
	 * Delivery paths check this before handing the batch over, so a removal that
	 * lands during the claim still takes effect rather than being overtaken by
	 * a send the user already cancelled.
	 */
	isCancelled(id: string): boolean {
		return this.cancelledIds.has(id)
	}

	private deliverable(entry: QueuedInputEntry): boolean {
		return !entry.editing && !this.claimedIds.has(entry.id)
	}

	/**
	 * Mark an entry as handed to a delivery.
	 *
	 * The flag is written onto the entry itself, not only into `claimedIds`, so
	 * the next snapshot records that a delivery was in progress. That record is
	 * what lets a reload tell "never sent" apart from "may already have been
	 * sent".
	 */
	private markClaimed(entry: QueuedInputEntry): QueuedInputEntry {
		const claimed: QueuedInputEntry = { ...entry, delivering: true }
		this.claimedIds.add(entry.id)
		this.replace(entry.id, claimed)
		return claimed
	}

	/** Claim the front-most deliverable `queued` entry for one turn-end. */
	takeNextQueued(): QueuedInputEntry | undefined {
		const claimed = this.entries.find((entry) => entry.mode === "queued" && this.deliverable(entry))
		return claimed ? { ...this.markClaimed(claimed) } : undefined
	}

	/** Claim every deliverable `steering` entry for one round. */
	takeSteeringBatch(): QueuedInputEntry[] {
		const claimed = this.entries.filter((entry) => entry.mode === "steering" && this.deliverable(entry))
		return claimed.map((entry) => ({ ...this.markClaimed(entry) }))
	}

	/**
	 * Drop claimed entries once their delivery is known to have landed.
	 *
	 * This is the only path that discards an entry the user did not remove, and
	 * it runs after delivery rather than before, so a rejected delivery can
	 * never lose the input.
	 */
	commitClaim(ids: readonly string[]): void {
		if (ids.length === 0) return
		const dropped = new Set(ids)
		this.entries = this.entries.filter((entry) => !dropped.has(entry.id))
		for (const id of dropped) {
			this.claimedIds.delete(id)
			this.cancelledIds.delete(id)
		}
		this.resequence()
	}

	/**
	 * Return claimed entries after a failed delivery.
	 *
	 * The entries never left the list, so they reappear exactly where the user
	 * last put them, even if the list was reordered while the delivery was in
	 * flight. Ids the user removed meanwhile stay removed.
	 */
	releaseClaim(ids: readonly string[]): void {
		for (const id of ids) {
			this.cancelledIds.delete(id)
			if (!this.claimedIds.delete(id)) continue
			const entry = this.get(id)
			// Clear the durable mark too, otherwise a reload would drop an entry
			// whose delivery is already known to have failed.
			if (entry) this.replace(id, { ...entry, delivering: false })
		}
	}

	/**
	 * Hide entries again after a release that could not be written.
	 *
	 * The file still marks them in flight, so a reload will drop them. Leaving
	 * them visible would offer the user input that is about to disappear, and
	 * would let them claim it a second time. Withholding keeps what the user
	 * sees consistent with what would survive a reload.
	 */
	reclaim(ids: readonly string[]): void {
		for (const id of ids) {
			const entry = this.get(id)
			if (!entry) continue
			this.claimedIds.add(id)
			this.replace(id, { ...entry, delivering: true })
		}
	}

	/**
	 * Project the queue for persistence.
	 *
	 * In-flight entries are deliberately included, unlike {@link list}: they
	 * carry the `delivering` mark, which is what lets a reload tell "never sent"
	 * apart from "may already have been sent". An entry only leaves the file
	 * once its claim commits or its delivery is known to have failed. See
	 * {@link fromSerialized} for how a marked entry is treated on reload.
	 */
	serialize(): QueuedInputEntry[] {
		return this.entries.map((entry) => ({ ...entry }))
	}

	private replace(id: string, next: QueuedInputEntry): void {
		const index = this.entries.findIndex((entry) => entry.id === id)
		if (index < 0) return
		this.entries[index] = next
	}
}
