import { describe, expect, it } from "vitest"
import { InMemoryConversationJournal } from "../InMemoryRuntimeStores"

const message = (operationId: string, payloadRef: string) => ({ operationId, payloadRef, source: "system" as const })

describe("InMemoryConversationJournal", () => {
	it("tracks idempotent append, projection markers and epoch rebase", async () => {
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
		const rebased = await journal.rebase({ operationId: "rebase:1", reasonRef: "rebase:reason" })

		expect(duplicate).toEqual({ watermark: first.watermark, disposition: "existing" })
		expect([first, finalized, tombstone, checkpoint].map((result) => result.watermark.seq)).toEqual([1, 2, 3, 4])
		expect(rebased.watermark).toEqual({ epoch: 1, seq: 1 })
		expect((await journal.project(checkpoint.watermark)).visibleMessages).toEqual([
			expect.objectContaining({ payloadRef: "message:2" }),
		])
		expect(await journal.read(checkpoint.watermark)).toEqual([
			expect.objectContaining({ kind: "rebase", watermark: { epoch: 1, seq: 1 } }),
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
				from: { epoch: 0, seq: 2 },
				to: { epoch: 0, seq: 1 },
			}),
		).rejects.toThrow("must be ordered")
	})
})
