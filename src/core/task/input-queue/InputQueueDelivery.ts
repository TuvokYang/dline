import type { SemanticInputDocument } from "@shared/input-semantics/document"
import type { InputQueue, QueuedInputEntry } from "./InputQueue"

/**
 * Where the task currently sits when the queue is consulted.
 *
 * - `turn-end`: the assistant turn has ended and the task is about to wait for
 *   the user, so a queued entry may take the turn.
 * - `tool-round`: an ordinary tool round finished while the task keeps running;
 *   only steering entries may ride along here.
 */
export type QueueDeliveryPoint = "turn-end" | "tool-round"

export interface QueueDelivery {
	/** Which pool produced this batch; steering always takes priority. */
	readonly kind: "queued" | "steering"
	readonly entries: readonly QueuedInputEntry[]
	/**
	 * One pure user-authored text block per entry. The Task host owns the model
	 * envelope so internal guidance and XML formatting cannot leak into UI data.
	 */
	readonly blocks: readonly string[]
	/** Pure user-authored payload. Internal guidance is composed by the host. */
	readonly text: string
	readonly images: readonly string[]
	readonly files: readonly string[]
	/**
	 * The retained structure of each entry, in delivery order.
	 *
	 * Kept per entry rather than merged: two steering entries own their own
	 * commands and resources, and flattening them would lose which input a
	 * resource or lifecycle barrier belongs to.
	 */
	readonly documents: readonly (SemanticInputDocument | undefined)[]
	/** Discard the entries once the delivery is known to have landed. */
	commit(): void
	/** Return the entries to the user's queue when delivery failed. */
	restore(): void
	/**
	 * Hide the entries again after a restore that could not be persisted.
	 *
	 * The file still marks them in flight, so a reload would drop them.
	 * Showing them in the composer would promise a recovery the task cannot
	 * keep; withholding them keeps memory consistent with disk.
	 */
	reclaim(): void
	/**
	 * Rebuild this batch without the entries the user removed since the claim.
	 *
	 * Removal outranks a delivery that has not sent yet, and a remove request
	 * can land after the claim. Callers narrow the batch immediately before
	 * handing it over so a cancelled entry is not sent anyway.
	 *
	 * @returns the remaining batch, or undefined when nothing is left to send.
	 */
	withoutCancelled(): QueueDelivery | undefined
}

function renderBlocks(entries: readonly QueuedInputEntry[]): string[] {
	return entries.map((entry) => entry.text)
}

function buildDelivery(queue: InputQueue, kind: QueueDelivery["kind"], entries: readonly QueuedInputEntry[]): QueueDelivery {
	const blocks = renderBlocks(entries)
	const ids = entries.map((entry) => entry.id)
	return {
		kind,
		entries,
		blocks,
		text: blocks.join("\n\n"),
		images: entries.flatMap((entry) => [...entry.images]),
		files: entries.flatMap((entry) => [...entry.files]),
		documents: entries.map((entry) => entry.semanticInput),
		commit: () => queue.commitClaim(ids),
		restore: () => queue.releaseClaim(ids),
		reclaim: () => queue.reclaim(ids),
		withoutCancelled: () => {
			// Evaluated on call, not when the batch was built: the whole point is
			// to see removals that landed after the claim was taken.
			const live = entries.filter((entry) => !queue.isCancelled(entry.id))
			if (live.length === entries.length) return buildDelivery(queue, kind, entries)
			// Settle the cancelled ids here so their claim does not outlive the
			// batch; the remaining entries keep theirs until the caller settles.
			queue.commitClaim(ids.filter((id) => queue.isCancelled(id)))
			return live.length > 0 ? buildDelivery(queue, kind, live) : undefined
		},
	}
}

/**
 * Claim the batch owed to the current delivery point.
 *
 * The entries are only hidden from the user's queue, not removed: the caller
 * decides their fate with `commit()` or `restore()` once the delivery outcome is
 * known, so a rejected delivery cannot lose input and cannot reappear in the
 * wrong position after a concurrent reorder.
 *
 * Steering entries always win the round; a queued entry displaced by steering is
 * deferred to the next turn end rather than dropped. Entries under edit are held
 * back individually until the user commits the edit.
 */
export function takeQueueDelivery(queue: InputQueue, point: QueueDeliveryPoint): QueueDelivery | undefined {
	const steering = queue.takeSteeringBatch()
	if (steering.length > 0) {
		return buildDelivery(queue, "steering", steering)
	}
	if (point !== "turn-end") {
		return undefined
	}
	const queued = queue.takeNextQueued()
	return queued ? buildDelivery(queue, "queued", [queued]) : undefined
}
