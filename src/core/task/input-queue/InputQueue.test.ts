import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { describe, expect, it } from "vitest"
import { INPUT_QUEUE_LIMIT, InputQueue } from "./InputQueue"

function draft(text: string) {
	return { text, images: [], files: [] }
}

/** A document the shared validator accepts, so the queue keeps it. */
function semanticInput(overrides: Partial<SemanticInputDocument> = {}): SemanticInputDocument {
	return {
		schemaVersion: 1,
		parserVersion: "1.0.0",
		catalogRevision: "3",
		documentId: "doc-1",
		rawText: "A",
		nodes: [{ kind: "text", text: "A" }],
		resources: [],
		...overrides,
	}
}

/** Enqueue and fail loudly if the queue rejected the draft, so a silent limit hit never masks a broken expectation. */
function enqueued(queue: InputQueue, text: string): string {
	const id = queue.enqueue(draft(text))
	if (!id) throw new Error(`queue rejected "${text}"`)
	return id
}

describe("InputQueue", () => {
	// The composed structure is what delivery acts on. Re-deriving it from
	// `text` is exactly the string-matching this replaced, so an entry has to
	// carry it and a reload has to prove it is still valid.
	describe("retained semantic input", () => {
		it("keeps the composed structure with the entry it belongs to", () => {
			const queue = new InputQueue()

			queue.enqueue({ ...draft("A"), semanticInput: semanticInput() })
			queue.enqueue(draft("B"))

			expect(queue.list().map((entry) => entry.semanticInput?.documentId)).toEqual(["doc-1", undefined])
		})

		it("marks a restored structure stale so delivery revalidates it", () => {
			const queue = InputQueue.fromSerialized([
				{ id: "a", text: "A", images: [], files: [], mode: "queued", sequence: 0, semanticInput: semanticInput() },
			])

			expect(queue.list()[0].semanticInput?.documentId).toBe("doc-1")
			expect(queue.list()[0].semanticInputStale).toBe(true)
		})

		it("keeps the text deliverable when the persisted structure no longer validates", () => {
			const queue = InputQueue.fromSerialized([
				{
					id: "a",
					text: "A",
					images: [],
					files: [],
					mode: "queued",
					sequence: 0,
					semanticInput: semanticInput({ schemaVersion: 99 as 1 }),
				},
			])

			expect(queue.list()[0].text).toBe("A")
			expect(queue.list()[0].semanticInput).toBeUndefined()
			expect(queue.list()[0].semanticInputStale).toBeUndefined()
		})

		it("replaces the structure when the user commits an edit", () => {
			const queue = InputQueue.fromSerialized([
				{ id: "a", text: "A", images: [], files: [], mode: "queued", sequence: 0, semanticInput: semanticInput() },
			])
			queue.beginEdit("a")

			queue.commitEdit("a", { ...draft("A edited"), semanticInput: semanticInput({ documentId: "doc-2" }) })

			expect(queue.list()[0].semanticInput?.documentId).toBe("doc-2")
			expect(queue.list()[0].semanticInputStale).toBeUndefined()
		})

		it("drops the structure when an edit commits plain text over it", () => {
			const queue = new InputQueue()
			const id = queue.enqueue({ ...draft("A"), semanticInput: semanticInput() })
			if (!id) throw new Error("queue rejected the draft")
			queue.beginEdit(id)

			queue.commitEdit(id, draft("A edited"))

			expect(queue.list()[0].semanticInput).toBeUndefined()
		})
	})

	// Persisted state is untrusted input: a corrupted or hand-edited file can
	// repeat an id. Ids address entries individually, so a duplicate makes one
	// claim, removal or commit act on someone else's text.
	describe("duplicate persisted ids", () => {
		it("gives each entry its own identity when the file repeats one", () => {
			const queue = InputQueue.fromSerialized([
				{ id: "dup", text: "A", images: [], files: [], mode: "queued", sequence: 0 },
				{ id: "dup", text: "B", images: [], files: [], mode: "queued", sequence: 1 },
			])

			const ids = queue.list().map((entry) => entry.id)

			expect(queue.list().map((entry) => entry.text)).toEqual(["A", "B"])
			expect(new Set(ids).size).toBe(2)
		})

		it("keeps the entry that was not delivered when a claim is committed", () => {
			const queue = InputQueue.fromSerialized([
				{ id: "dup", text: "A", images: [], files: [], mode: "queued", sequence: 0 },
				{ id: "dup", text: "B", images: [], files: [], mode: "queued", sequence: 1 },
			])

			const claimed = queue.takeNextQueued()
			if (!claimed) throw new Error("expected an entry to claim")
			queue.commitClaim([claimed.id])

			expect(queue.list().map((entry) => entry.text)).toEqual(["B"])
		})

		it("removes only the entry the user asked to drop", () => {
			const queue = InputQueue.fromSerialized([
				{ id: "dup", text: "A", images: [], files: [], mode: "queued", sequence: 0 },
				{ id: "dup", text: "B", images: [], files: [], mode: "queued", sequence: 1 },
			])
			const [, second] = queue.list()

			expect(queue.remove(second.id)).toBe(true)

			expect(queue.list().map((entry) => entry.text)).toEqual(["A"])
		})
	})

	describe("enqueue", () => {
		it("enqueues as queued and preserves insertion order", () => {
			const queue = new InputQueue()
			queue.enqueue(draft("first"))
			queue.enqueue(draft("second"))

			expect(queue.list().map((entry) => entry.text)).toEqual(["first", "second"])
			expect(queue.list().every((entry) => entry.mode === "queued")).toBe(true)
		})

		it("rejects enqueue beyond the limit without evicting existing entries", () => {
			const queue = new InputQueue()
			for (let index = 0; index < INPUT_QUEUE_LIMIT; index++) {
				expect(queue.enqueue(draft(`entry-${index}`))).toBeDefined()
			}

			expect(queue.enqueue(draft("overflow"))).toBeUndefined()
			expect(queue.list()).toHaveLength(INPUT_QUEUE_LIMIT)
			expect(queue.list()[0]?.text).toBe("entry-0")
			expect(queue.list().some((entry) => entry.text === "overflow")).toBe(false)
		})
	})

	describe("mode toggle", () => {
		// Clicking send only changes state; delivery is driven by the next round.
		it("toggles between queued and steering without delivering", () => {
			const queue = new InputQueue()
			const id = enqueued(queue, "align on this")

			queue.toggleMode(id)
			expect(queue.get(id)?.mode).toBe("steering")

			queue.toggleMode(id)
			expect(queue.get(id)?.mode).toBe("queued")
		})

		it("leaves other entries untouched when one is toggled", () => {
			const queue = new InputQueue()
			const first = enqueued(queue, "first")
			queue.enqueue(draft("second"))

			queue.toggleMode(first)

			expect(queue.get(first)?.mode).toBe("steering")
			expect(queue.list()[1]?.mode).toBe("queued")
		})
	})

	describe("reorder", () => {
		// Order is the FIFO consumption order, so dragging decides what the next
		// turn-end delivers.
		it("moves an entry to a new position and keeps the rest in order", () => {
			const queue = new InputQueue()
			queue.enqueue(draft("a"))
			const b = enqueued(queue, "b")
			queue.enqueue(draft("c"))

			queue.reorder(b, 0)

			expect(queue.list().map((entry) => entry.text)).toEqual(["b", "a", "c"])
		})

		it("consumes according to the reordered sequence", () => {
			const queue = new InputQueue()
			queue.enqueue(draft("a"))
			const b = enqueued(queue, "b")
			queue.reorder(b, 0)

			expect(queue.takeNextQueued()?.text).toBe("b")
		})
	})

	describe("editing gate", () => {
		// An entry pulled back into the composer must not be delivered mid-edit.
		it("skips an editing entry and takes the next queued one instead", () => {
			const queue = new InputQueue()
			const first = enqueued(queue, "being edited")
			queue.enqueue(draft("ready"))

			queue.beginEdit(first)

			expect(queue.takeNextQueued()?.text).toBe("ready")
			expect(queue.get(first)).toBeDefined()
		})

		it("excludes an editing entry from a steering batch while the rest are delivered", () => {
			const queue = new InputQueue()
			const first = enqueued(queue, "being edited")
			const second = enqueued(queue, "ready")
			queue.toggleMode(first)
			queue.toggleMode(second)
			queue.beginEdit(first)

			expect(queue.takeSteeringBatch().map((entry) => entry.text)).toEqual(["ready"])
			expect(queue.get(first)?.mode).toBe("steering")
		})

		it("restores content at the same position and mode after an edit commits", () => {
			const queue = new InputQueue()
			queue.enqueue(draft("first"))
			const second = enqueued(queue, "second")
			queue.toggleMode(second)

			queue.beginEdit(second)
			queue.commitEdit(second, draft("second edited"))

			const entries = queue.list()
			expect(entries.map((entry) => entry.text)).toEqual(["first", "second edited"])
			expect(entries[1]?.mode).toBe("steering")
			expect(entries[1]?.editing).toBeFalsy()
		})
	})

	describe("delivery", () => {
		it("takes exactly one queued entry per turn-end and leaves the rest", () => {
			const queue = new InputQueue()
			queue.enqueue(draft("first"))
			queue.enqueue(draft("second"))

			expect(queue.takeNextQueued()?.text).toBe("first")
			expect(queue.list().map((entry) => entry.text)).toEqual(["second"])
		})

		it("takes every steering entry at once", () => {
			const queue = new InputQueue()
			const first = enqueued(queue, "first")
			const second = enqueued(queue, "second")
			queue.enqueue(draft("stays queued"))
			queue.toggleMode(first)
			queue.toggleMode(second)

			expect(queue.takeSteeringBatch().map((entry) => entry.text)).toEqual(["first", "second"])
			expect(queue.list().map((entry) => entry.text)).toEqual(["stays queued"])
		})

		it("never returns a steering entry from the queued path", () => {
			const queue = new InputQueue()
			const first = enqueued(queue, "steering")
			queue.toggleMode(first)

			expect(queue.takeNextQueued()).toBeUndefined()
		})

		it("returns entries to the queue at their original position when delivery fails", () => {
			const queue = new InputQueue()
			queue.enqueue(draft("first"))
			const second = enqueued(queue, "second")
			queue.enqueue(draft("third"))

			const taken = queue.takeNextQueued()
			expect(taken?.text).toBe("first")
			queue.releaseClaim(taken ? [taken.id] : [])

			expect(queue.list().map((entry) => entry.text)).toEqual(["first", "second", "third"])
			expect(queue.get(second)).toBeDefined()
		})

		// A claimed entry must stay out of the user's view until its fate is
		// known, otherwise the composer would offer an entry that is already
		// on its way to the model.
		it("hides a claimed entry until the claim is settled", () => {
			const queue = new InputQueue()
			enqueued(queue, "first")
			enqueued(queue, "second")

			const taken = queue.takeNextQueued()

			expect(queue.list().map((entry) => entry.text)).toEqual(["second"])
			expect(queue.size).toBe(1)
			queue.commitClaim(taken ? [taken.id] : [])
			expect(queue.list().map((entry) => entry.text)).toEqual(["second"])
		})

		it("restores a failed steering batch as a whole", () => {
			const queue = new InputQueue()
			const first = enqueued(queue, "first")
			const second = enqueued(queue, "second")
			queue.toggleMode(first)
			queue.toggleMode(second)

			const batch = queue.takeSteeringBatch()
			queue.releaseClaim(batch.map((entry) => entry.id))

			expect(queue.list().map((entry) => entry.text)).toEqual(["first", "second"])
			expect(queue.list().every((entry) => entry.mode === "steering")).toBe(true)
		})

		// The user may reorder while a delivery is in flight. Their drop target
		// addresses the list they can see, which excludes the claimed entry, so
		// the claim must not shift where the moved entry lands.
		it("reorders against the visible list while a claim is in flight", () => {
			const queue = new InputQueue()
			enqueued(queue, "first")
			enqueued(queue, "second")
			const third = enqueued(queue, "third")

			const taken = queue.takeNextQueued()
			expect(taken?.text).toBe("first")
			// Visible list is ["second", "third"]; index 0 means before "second".
			queue.reorder(third, 0)
			expect(queue.list().map((entry) => entry.text)).toEqual(["third", "second"])

			queue.releaseClaim(taken ? [taken.id] : [])

			expect(queue.list().map((entry) => entry.text)).toEqual(["first", "third", "second"])
		})

		// A user request travels over RPC, so it can land after the entry was
		// claimed. Applying it then would edit content already on its way to the
		// model, and the edit would vanish when the claim commits.
		it("refuses to mutate an entry that is already in flight", () => {
			const queue = new InputQueue()
			const first = enqueued(queue, "first")
			enqueued(queue, "second")

			const taken = queue.takeNextQueued()
			expect(taken?.id).toBe(first)

			expect(queue.toggleMode(first)).toBeUndefined()
			expect(queue.beginEdit(first)).toBeUndefined()
			expect(queue.commitEdit(first, draft("rewritten"))).toBeUndefined()
			expect(queue.cancelEdit(first)).toBe(false)

			// The claimed copy still carries what was actually sent.
			queue.releaseClaim([first])
			const restored = queue.get(first)
			expect(restored?.text).toBe("first")
			expect(restored?.mode).toBe("queued")
			expect(restored?.editing).toBeFalsy()
		})

		// A reload cannot tell whether an in-flight entry reached the model, so
		// it is dropped rather than sent again. Repeating an instruction can
		// undo work; losing one is visible to the user, who still has the text.
		it("drops an entry that was still in flight when the queue was persisted", () => {
			const queue = new InputQueue()
			enqueued(queue, "in flight")
			enqueued(queue, "untouched")
			const taken = queue.takeNextQueued()
			expect(taken?.text).toBe("in flight")

			const persisted = queue.serialize()
			expect(persisted.find((entry) => entry.text === "in flight")?.delivering).toBe(true)

			const reloaded = InputQueue.fromSerialized(persisted)
			expect(reloaded.list().map((entry) => entry.text)).toEqual(["untouched"])
			// The user never sees this input again, so the drop has to be
			// reportable rather than silent.
			expect(reloaded.droppedInFlightCount).toBe(1)
		})

		it("reports no drops for a queue that was not mid-delivery", () => {
			const queue = new InputQueue()
			enqueued(queue, "first")

			expect(InputQueue.fromSerialized(queue.serialize()).droppedInFlightCount).toBe(0)
		})

		// A delivery that is known to have failed clears the mark, so the entry
		// survives a later reload instead of being mistaken for a possible send.
		it("keeps a released entry across a reload", () => {
			const queue = new InputQueue()
			const id = enqueued(queue, "never sent")
			queue.takeNextQueued()
			queue.releaseClaim([id])

			const reloaded = InputQueue.fromSerialized(queue.serialize())

			expect(reloaded.list().map((entry) => entry.text)).toEqual(["never sent"])
			expect(reloaded.takeNextQueued()?.text).toBe("never sent")
		})

		// Persistence must not drop in-flight input: a crash or a failed restore
		// write during delivery would otherwise lose input nobody deleted.
		it("keeps an in-flight entry in the persisted projection", () => {
			const queue = new InputQueue()
			enqueued(queue, "first")
			enqueued(queue, "second")

			const taken = queue.takeNextQueued()
			expect(taken?.text).toBe("first")

			expect(queue.list().map((entry) => entry.text)).toEqual(["second"])
			expect(queue.serialize().map((entry) => entry.text)).toEqual(["first", "second"])
			// Once committed it is gone from disk too.
			queue.commitClaim(taken ? [taken.id] : [])
			expect(queue.serialize().map((entry) => entry.text)).toEqual(["second"])
		})

		// Removal is the user's decision and outranks an in-flight claim, so a
		// released entry must not reappear after they deleted it.
		it("keeps a removed entry gone when its claim is released", () => {
			const queue = new InputQueue()
			const first = enqueued(queue, "first")
			enqueued(queue, "second")

			const taken = queue.takeNextQueued()
			expect(taken?.id).toBe(first)
			queue.remove(first)
			queue.releaseClaim([first])

			expect(queue.list().map((entry) => entry.text)).toEqual(["second"])
		})

		// A remove that lands during the claim has to reach the delivery, which
		// still holds its own copy of the entry and would otherwise send it.
		it("marks an entry removed during its claim as cancelled", () => {
			const queue = new InputQueue()
			const first = enqueued(queue, "first")
			const second = enqueued(queue, "second")

			queue.takeNextQueued()
			expect(queue.isCancelled(first)).toBe(false)
			queue.remove(first)

			expect(queue.isCancelled(first)).toBe(true)
			expect(queue.isCancelled(second)).toBe(false)
		})
	})

	describe("remove", () => {
		it("removes only the requested entry", () => {
			const queue = new InputQueue()
			queue.enqueue(draft("keep"))
			const target = enqueued(queue, "drop")

			queue.remove(target)

			expect(queue.list().map((entry) => entry.text)).toEqual(["keep"])
		})
	})

	describe("persistence", () => {
		it("restores a serialized queue with order, mode and content intact", () => {
			const queue = new InputQueue()
			queue.enqueue(draft("first"))
			const second = enqueued(queue, "second")
			queue.toggleMode(second)

			const restored = InputQueue.fromSerialized(queue.serialize())

			expect(restored.list().map((entry) => entry.text)).toEqual(["first", "second"])
			expect(restored.list()[1]?.mode).toBe("steering")
		})

		// A task reloaded from disk must never resume mid-edit: the composer that
		// held the content is gone, so the entry has to be deliverable again.
		// Reordering is the user's explicit statement of delivery order, so a
		// failed delivery must land back in the position they chose rather than
		// where the entry was originally typed.
		it("restores a claimed entry into its reordered position", () => {
			const queue = new InputQueue()
			enqueued(queue, "first")
			enqueued(queue, "second")
			const third = enqueued(queue, "third")
			queue.reorder(third, 0)

			const taken = queue.takeNextQueued()
			expect(taken?.text).toBe("third")
			queue.releaseClaim(taken ? [taken.id] : [])

			expect(queue.list().map((entry) => entry.text)).toEqual(["third", "first", "second"])
		})

		// An in-flight entry still occupies its slot, so the limit cannot be
		// exceeded by queueing while a delivery is pending.
		it("counts an in-flight entry against the limit", () => {
			const queue = new InputQueue()
			enqueued(queue, "claimed")
			const taken = queue.takeNextQueued()
			expect(taken).toBeDefined()
			for (let index = 0; index < INPUT_QUEUE_LIMIT - 1; index++) {
				enqueued(queue, `filler-${index}`)
			}

			expect(queue.enqueue(draft("one too many"))).toBeUndefined()

			queue.releaseClaim(taken ? [taken.id] : [])
			expect(queue.size).toBe(INPUT_QUEUE_LIMIT)
			expect(queue.list().some((entry) => entry.text === "claimed")).toBe(true)
		})

		it("clears the editing gate when restoring", () => {
			const queue = new InputQueue()
			const id = enqueued(queue, "was editing")
			queue.beginEdit(id)

			const restored = InputQueue.fromSerialized(queue.serialize())

			expect(restored.get(id)?.editing).toBeFalsy()
			expect(restored.takeNextQueued()?.text).toBe("was editing")
		})

		// The limit bounds new input only. Everything on disk was already
		// accepted, so a reload that truncated it would delete user input that
		// the user never removed.
		it("keeps an over-limit persisted queue whole", () => {
			const oversized = Array.from({ length: INPUT_QUEUE_LIMIT + 5 }, (_, index) => ({
				id: `entry-${index}`,
				text: `entry-${index}`,
				images: [],
				files: [],
				mode: "queued" as const,
				sequence: index,
			}))

			const restored = InputQueue.fromSerialized(oversized)

			expect(restored.list()).toHaveLength(INPUT_QUEUE_LIMIT + 5)
			expect(restored.serialize().map((entry) => entry.text)).toEqual(oversized.map((entry) => entry.text))
			// Still refuses new input while it sits above the limit.
			expect(restored.enqueue(draft("blocked"))).toBeUndefined()
		})

		// Unusable data is not lost input. Counting it as a dropped delivery
		// would report input the user never had.
		it("does not count unusable data as a dropped delivery", () => {
			const restored = InputQueue.fromSerialized([
				{ id: "broken", delivering: true, mode: "queued" },
				{ id: "usable", text: "kept", images: [], files: [], mode: "queued", sequence: 0 },
			])

			expect(restored.list().map((entry) => entry.text)).toEqual(["kept"])
			expect(restored.droppedInFlightCount).toBe(0)
		})
	})

	describe("transactions", () => {
		// A change is only real once it is on disk, so a failed write has to be
		// undone rather than shown to the user.
		it("undoes a change when rolled back to a checkpoint", () => {
			const queue = new InputQueue()
			const first = enqueued(queue, "first")

			const checkpoint = queue.checkpoint()
			queue.remove(first)
			enqueued(queue, "added after checkpoint")
			expect(queue.list().map((entry) => entry.text)).toEqual(["added after checkpoint"])

			queue.rollback(checkpoint)

			expect(queue.list().map((entry) => entry.text)).toEqual(["first"])
		})

		// Rebuilding from the serialized form would lose the claim, so a failed
		// mutation would corrupt a delivery that is still running.
		it("preserves an in-flight claim across a rollback", () => {
			const queue = new InputQueue()
			const claimedId = enqueued(queue, "in flight")
			enqueued(queue, "visible")
			const claimed = queue.takeNextQueued()
			expect(claimed?.id).toBe(claimedId)

			const checkpoint = queue.checkpoint()
			queue.remove(claimedId)
			expect(queue.isCancelled(claimedId)).toBe(true)

			queue.rollback(checkpoint)

			// Still claimed: hidden from the user, absent from a new claim, and
			// no longer cancelled.
			expect(queue.list().map((entry) => entry.text)).toEqual(["visible"])
			expect(queue.isCancelled(claimedId)).toBe(false)
			expect(queue.takeNextQueued()?.text).toBe("visible")
			queue.releaseClaim([claimedId])
			expect(queue.list().map((entry) => entry.text)).toEqual(["in flight"])
		})
	})
})
