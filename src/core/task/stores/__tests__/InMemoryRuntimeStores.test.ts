import { describe, expect, it } from "vitest"
import { InMemoryConversationJournal } from "../InMemoryRuntimeStores"

describe("InMemoryConversationJournal", () => {
	it("tracks transient finalize, epoch rebase and append-only control markers", async () => {
		const journal = new InMemoryConversationJournal()
		const first = await journal.append("message:1")
		journal.appendTransient("stream-1", "partial")
		const finalized = await journal.finalizeTransient("stream-1", "message:2")
		const tombstone = await journal.tombstone(first)
		const boundary = await journal.truncateBoundary(finalized)
		const superseded = await journal.supersedeRange(first, finalized)
		const checkpoint = await journal.checkpointMarker("checkpoint:1")
		const rebased = await journal.rebase("rebase:reason")

		expect([first.seq, finalized.seq, tombstone.seq, boundary.seq, superseded.seq, checkpoint.seq]).toEqual([
			1, 2, 3, 4, 5, 6,
		])
		expect(rebased).toEqual({ epoch: 1, seq: 1 })
		expect((await journal.read()).map((entry) => entry.kind)).toEqual([
			"message",
			"message",
			"tombstone",
			"truncate_boundary",
			"supersede_range",
			"checkpoint_marker",
			"rebase",
		])
		expect(await journal.read(checkpoint)).toEqual([
			expect.objectContaining({ kind: "rebase", watermark: { epoch: 1, seq: 1 } }),
		])
	})

	it("rejects invalid finalize and reversed supersede ranges", async () => {
		const journal = new InMemoryConversationJournal()
		await expect(journal.finalizeTransient("missing")).rejects.toThrow("Unknown transient")
		await expect(journal.supersedeRange({ epoch: 0, seq: 2 }, { epoch: 0, seq: 1 })).rejects.toThrow("must be ordered")
	})
})
