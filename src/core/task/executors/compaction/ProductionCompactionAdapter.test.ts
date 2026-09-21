import { describe, expect, it } from "vitest"
import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { CompactionContextEnvelope, CompactionResultEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { ProductionCompactionAdapter } from "./ProductionCompactionAdapter"

class MemoryPayloads implements TaskPayloadStore {
	private sequence = 0
	private readonly values = new Map<string, Uint8Array>()
	async put(payload: Uint8Array): Promise<string> {
		const ref = `payload:${++this.sequence}`
		this.values.set(ref, payload)
		return ref
	}
	async read(ref: string): Promise<Uint8Array> {
		const value = this.values.get(ref)
		if (!value) throw new Error(`MissingPayload:${ref}`)
		return value
	}
}

describe("ProductionCompactionAdapter", () => {
	it("decodes context and materializes the compaction result", async () => {
		const payloads = new MemoryPayloads()
		const context: CompactionContextEnvelope = { kind: "compaction_context", context: { messages: 3 } }
		const contextRef = await payloads.put(encodeTaskPayload(context))
		const adapter = new ProductionCompactionAdapter({
			payloads,
			service: { run: async ({ context: decoded }) => ({ summary: decoded }) },
		})
		const result = await adapter.run({
			compactionId: "compact-1",
			attempt: "attempt-1",
			contextRef,
			signal: new AbortController().signal,
			publish: () => undefined,
		})
		expect(decodeTaskPayload<CompactionResultEnvelope>(await payloads.read(result.resultRef))).toEqual({
			kind: "compaction_result",
			result: { summary: { messages: 3 } },
		})
	})
})
