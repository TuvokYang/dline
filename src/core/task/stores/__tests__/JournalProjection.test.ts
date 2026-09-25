import { describe, expect, it } from "vitest"
import type { JournalEntry } from "../contracts"
import { rebuildJournalProjection } from "../JournalProjection"

function entry(seq: number, kind: JournalEntry["kind"], fields: Partial<JournalEntry> = {}): JournalEntry {
	return {
		version: 1,
		operationId: `${kind}:${seq}`,
		watermark: { seq },
		kind,
		...fields,
	}
}

describe("rebuildJournalProjection rewind", () => {
	const at = (seq: number) => ({ seq })
	const compacted = [
		entry(1, "message", { payloadRef: "task" }),
		entry(2, "message", { payloadRef: "history" }),
		entry(3, "message", { payloadRef: "answer" }),
		entry(4, "supersede_range", { range: { from: at(2), to: at(3) }, payloadRef: "summary" }),
		entry(5, "message", { payloadRef: "after-summary" }),
	]
	const refs = (entries: readonly JournalEntry[]) =>
		rebuildJournalProjection(entries).visibleMessages.map((message) => message.payloadRef)

	// Restoring a checkpoint taken before a compaction has to bring back the
	// conversation the summary replaced; a truncation there keeps the summary.
	it("returns the view to the target, dropping a summary recorded after it", () => {
		expect(refs(compacted)).toEqual(["task", "summary", "after-summary"])
		expect(refs([...compacted, entry(6, "rewind", { target: at(3) })])).toEqual(["task", "history", "answer"])
	})

	it("keeps later input and allows compacting again after the rewind", () => {
		const rewound = [
			...compacted,
			entry(6, "rewind", { target: at(3) }),
			entry(7, "message", { payloadRef: "resumed" }),
			entry(8, "supersede_range", { range: { from: at(2), to: at(7) }, payloadRef: "summary-2" }),
		]

		expect(refs(rewound)).toEqual(["task", "summary-2"])
	})

	it("refuses a later marker that addresses a message the rewind undid", () => {
		const rewound = [...compacted, entry(6, "rewind", { target: at(3) }), entry(7, "tombstone", { target: at(5) })]

		expect(() => rebuildJournalProjection(rewound)).toThrow("JournalMarkerTargetMissing")
	})

	it("refuses a rewind to a message that was never recorded", () => {
		expect(() => rebuildJournalProjection([...compacted, entry(6, "rewind", { target: at(9) })])).toThrow(
			"JournalMarkerTargetMissing",
		)
	})

	it("projects a prefix through the rewind exactly as it was before it", () => {
		const rewound = [...compacted, entry(6, "rewind", { target: at(3) })]

		expect(rebuildJournalProjection(rewound, at(5)).visibleMessages.map((message) => message.payloadRef)).toEqual([
			"task",
			"summary",
			"after-summary",
		])
	})
})

describe("rebuildJournalProjection", () => {
	it("applies tombstone, truncate and supersede markers only to earlier messages", () => {
		const entries: JournalEntry[] = [
			entry(1, "message", { payloadRef: "one" }),
			entry(2, "message", { payloadRef: "two" }),
			entry(3, "tombstone", { target: { seq: 1 } }),
			entry(4, "message", { payloadRef: "three" }),
			entry(5, "truncate_boundary", { target: { seq: 2 } }),
			entry(6, "message", { payloadRef: "four" }),
			entry(7, "supersede_range", { range: { from: { seq: 1 }, to: { seq: 2 } } }),
			entry(8, "checkpoint_marker", { payloadRef: "checkpoint:1" }),
		]

		const projection = rebuildJournalProjection(entries)
		expect(projection.visibleMessages.map((item) => item.payloadRef)).toEqual(["four"])
		expect(projection.checkpointMarkers).toEqual([expect.objectContaining({ payloadRef: "checkpoint:1" })])
	})

	it("shows a supersede replacement where its span began, ahead of later input", () => {
		const entries: JournalEntry[] = [
			entry(1, "message", { payloadRef: "task" }),
			entry(2, "message", { payloadRef: "answered" }),
			entry(3, "message", { payloadRef: "call" }),
			entry(4, "message", { payloadRef: "pending-reply" }),
			entry(5, "supersede_range", {
				range: { from: { seq: 2 }, to: { seq: 2 } },
				payloadRef: "summary:1",
			}),
		]

		const projection = rebuildJournalProjection(entries)

		expect(projection.visibleMessages.map((item) => item.payloadRef)).toEqual(["task", "summary:1", "call", "pending-reply"])
		// The replacement is ordinary visible history; the marker itself never is.
		expect(projection.visibleMessages[1]).toMatchObject({
			kind: "message",
			source: "system",
			watermark: { seq: 2 },
		})
	})

	it("lets a later supersede replace an earlier replacement by its position", () => {
		const entries: JournalEntry[] = [
			entry(1, "message", { payloadRef: "task" }),
			entry(2, "message", { payloadRef: "answered" }),
			entry(3, "supersede_range", {
				range: { from: { seq: 2 }, to: { seq: 2 } },
				payloadRef: "summary:1",
			}),
			entry(4, "message", { payloadRef: "later" }),
			entry(5, "message", { payloadRef: "pending" }),
			entry(6, "supersede_range", {
				range: { from: { seq: 2 }, to: { seq: 4 } },
				payloadRef: "summary:2",
			}),
		]

		const projection = rebuildJournalProjection(entries)

		expect(projection.visibleMessages.map((item) => item.payloadRef)).toEqual(["task", "summary:2", "pending"])
	})

	it("gives a summary way to its originals when a tombstone removes part of its span", () => {
		const entries: JournalEntry[] = [
			entry(1, "message", { payloadRef: "task" }),
			entry(2, "message", { payloadRef: "two" }),
			entry(3, "message", { payloadRef: "three" }),
			entry(4, "message", { payloadRef: "four" }),
			entry(5, "supersede_range", {
				range: { from: { seq: 2 }, to: { seq: 4 } },
				payloadRef: "summary:1",
			}),
			entry(6, "tombstone", { target: { seq: 3 } }),
		]

		// The summary still spoke for message three, so it cannot stay once three is undone.
		expect(rebuildJournalProjection(entries).visibleMessages.map((item) => item.payloadRef)).toEqual(["task", "two", "four"])
	})

	it("drops a summary whose span a truncation cuts into, keeping the originals before the boundary", () => {
		const entries: JournalEntry[] = [
			entry(1, "message", { payloadRef: "task" }),
			entry(2, "message", { payloadRef: "two" }),
			entry(3, "message", { payloadRef: "three" }),
			entry(4, "message", { payloadRef: "four" }),
			entry(5, "supersede_range", {
				range: { from: { seq: 2 }, to: { seq: 4 } },
				payloadRef: "summary:1",
			}),
			entry(6, "truncate_boundary", { target: { seq: 3 } }),
		]

		expect(rebuildJournalProjection(entries).visibleMessages.map((item) => item.payloadRef)).toEqual(["task", "two", "three"])
	})

	it("keeps a summary when a truncation ends exactly at its span", () => {
		const entries: JournalEntry[] = [
			entry(1, "message", { payloadRef: "task" }),
			entry(2, "message", { payloadRef: "two" }),
			entry(3, "message", { payloadRef: "three" }),
			entry(4, "supersede_range", {
				range: { from: { seq: 2 }, to: { seq: 3 } },
				payloadRef: "summary:1",
			}),
			entry(5, "message", { payloadRef: "later" }),
			entry(6, "truncate_boundary", { target: { seq: 3 } }),
		]

		expect(rebuildJournalProjection(entries).visibleMessages.map((item) => item.payloadRef)).toEqual(["task", "summary:1"])
	})

	it("unfolds a nested summary back to journal originals, not to the summary it replaced", () => {
		const entries: JournalEntry[] = [
			entry(1, "message", { payloadRef: "task" }),
			entry(2, "message", { payloadRef: "two" }),
			entry(3, "supersede_range", {
				range: { from: { seq: 2 }, to: { seq: 2 } },
				payloadRef: "summary:1",
			}),
			entry(4, "message", { payloadRef: "four" }),
			entry(5, "supersede_range", {
				range: { from: { seq: 2 }, to: { seq: 4 } },
				payloadRef: "summary:2",
			}),
			entry(6, "tombstone", { target: { seq: 4 } }),
		]

		expect(rebuildJournalProjection(entries).visibleMessages.map((item) => item.payloadRef)).toEqual(["task", "two"])
	})

	it("keeps a supersede without replacement a pure hide", () => {
		const entries: JournalEntry[] = [
			entry(1, "message", { payloadRef: "one" }),
			entry(2, "message", { payloadRef: "two" }),
			entry(3, "supersede_range", { range: { from: { seq: 2 }, to: { seq: 2 } } }),
		]

		expect(rebuildJournalProjection(entries).visibleMessages.map((item) => item.payloadRef)).toEqual(["one"])
	})

	it("rejects sequence gaps and markers that reference unknown entries", () => {
		expect(() => rebuildJournalProjection([entry(2, "message", { payloadRef: "gap" })])).toThrow("InvalidJournalGenesis")
		expect(() =>
			rebuildJournalProjection([entry(1, "message", { payloadRef: "one" }), entry(2, "tombstone", { target: { seq: 9 } })]),
		).toThrow("JournalMarkerTargetMissing")
	})
})
