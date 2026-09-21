import { describe, expect, it, vi } from "vitest"
import type { TaskPayloadStore } from "../../stores"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { TaskHandoffEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { ProductionSpawnAdapter } from "./ProductionSpawnAdapter"

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

describe("ProductionSpawnAdapter", () => {
	it("reserves, admits, and disposes a decoded child handoff", async () => {
		const payloads = new MemoryPayloads()
		const handoff: TaskHandoffEnvelope = {
			kind: "task_handoff",
			context: "continue",
			source: { functionId: "fn-1", dlineTid: "block-1" },
			initialUserContent: [],
			taskSettings: { mode: "act" },
		}
		const handoffRef = await payloads.put(encodeTaskPayload(handoff))
		const admit = vi.fn(async () => undefined)
		const dispose = vi.fn(async () => undefined)
		const adapter = new ProductionSpawnAdapter({
			payloads,
			launcher: { reserve: async () => ({ childTaskId: "child-1", admit, dispose }) },
		})
		const lease = await adapter.prepare({ spawnAttempt: "spawn-1", handoffRef, signal: new AbortController().signal })
		await expect(lease.admit(new AbortController().signal)).resolves.toEqual({ childTaskId: "child-1" })
		await lease.dispose("test")
		expect(admit).toHaveBeenCalledOnce()
		expect(dispose).toHaveBeenCalledWith("test")
	})
})
