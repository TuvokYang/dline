import { describe, expect, it } from "vitest"
import type { JournalEntry } from "../contracts"
import { rebuildJournalProjection } from "../JournalProjection"

function entry(seq: number, kind: JournalEntry["kind"], fields: Partial<JournalEntry> = {}): JournalEntry {
	return {
		version: 1,
		operationId: `${kind}:${seq}`,
		watermark: { epoch: 0, seq },
		kind,
		...fields,
	}
}

describe("rebuildJournalProjection", () => {
	it("applies tombstone, truncate and supersede markers only to earlier messages", () => {
		const entries: JournalEntry[] = [
			entry(1, "message", { payloadRef: "one" }),
			entry(2, "message", { payloadRef: "two" }),
			entry(3, "tombstone", { target: { epoch: 0, seq: 1 } }),
			entry(4, "message", { payloadRef: "three" }),
			entry(5, "truncate_boundary", { target: { epoch: 0, seq: 2 } }),
			entry(6, "message", { payloadRef: "four" }),
			entry(7, "supersede_range", { range: { from: { epoch: 0, seq: 1 }, to: { epoch: 0, seq: 2 } } }),
			entry(8, "checkpoint_marker", { payloadRef: "checkpoint:1" }),
		]

		const projection = rebuildJournalProjection(entries)
		expect(projection.visibleMessages.map((item) => item.payloadRef)).toEqual(["four"])
		expect(projection.checkpointMarkers).toEqual([expect.objectContaining({ payloadRef: "checkpoint:1" })])
	})

	it("rejects sequence gaps and markers that reference unknown entries", () => {
		expect(() => rebuildJournalProjection([entry(2, "message", { payloadRef: "gap" })])).toThrow("InvalidJournalGenesis")
		expect(() =>
			rebuildJournalProjection([
				entry(1, "message", { payloadRef: "one" }),
				entry(2, "tombstone", { target: { epoch: 0, seq: 9 } }),
			]),
		).toThrow("JournalMarkerTargetMissing")
	})
})
