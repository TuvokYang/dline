import { describe, expect, it } from "vitest"
import { InMemoryConversationJournal } from "../InMemoryRuntimeStores"

const message = (operationId: string, payloadRef: string) => ({ operationId, payloadRef, source: "system" as const })

describe("InMemoryConversationJournal", () => {
	it("tracks idempotent append and projection markers on one contiguous sequence", async () => {
		const journal = new InMemoryConversationJournal()
		const first = await journal.append(message("message:1", "message:1"))
		const duplicate = await journal.append(message("message:1", "message:1"))
		journal.appendTransient("stream-1", "partial")
		const finalized = await journal.finalizeTransient({
			...message("message:2", "message:2"),
			transientId: "stream-1",
		})
		const tombstone = await journal.tombstone({ operationId: "tombstone:1", target: first.watermark })
		const checkpoint = await journal.checkpointMarker({ operationId: "checkpoint:1", checkpointRef: "checkpoint:1" })
		const later = await journal.append(message("message:3", "message:3"))

		expect(duplicate).toEqual({ watermark: first.watermark, disposition: "existing" })
		expect([first, finalized, tombstone, checkpoint, later].map((result) => result.watermark)).toEqual([
			{ seq: 1 },
			{ seq: 2 },
			{ seq: 3 },
			{ seq: 4 },
			{ seq: 5 },
		])
		expect((await journal.project(checkpoint.watermark)).visibleMessages).toEqual([
			expect.objectContaining({ payloadRef: "message:2" }),
		])
		expect(await journal.read(checkpoint.watermark)).toEqual([
			expect.objectContaining({ kind: "message", watermark: { seq: 5 } }),
		])
	})

	it("rejects conflicts, invalid finalize and reversed supersede ranges", async () => {
		const journal = new InMemoryConversationJournal()
		await journal.append(message("message:1", "message:1"))
		await expect(journal.append(message("message:1", "different"))).rejects.toThrow("operation conflict")
		await expect(journal.finalizeTransient({ ...message("missing", ""), transientId: "missing" })).rejects.toThrow(
			"Unknown transient",
		)
		await expect(
			journal.supersedeRange({
				operationId: "range:1",
				from: { seq: 2 },
				to: { seq: 1 },
			}),
		).rejects.toThrow("must be ordered")
	})
})
