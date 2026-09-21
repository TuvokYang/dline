import { describe, expect, it, vi } from "vitest"
import type { TaskPayloadStore } from "../../stores"
import { InMemoryConversationJournal } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { ToolInvocationEnvelope, ToolResultEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { createProductionToolAdapter } from "./ProductionToolAdapter"
import { createDeniedSurface } from "./ToolDomainSurface"
import { TurnToolScheduler } from "./TurnToolScheduler"

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

describe("createProductionToolAdapter", () => {
	it("decodes invocations, persists results, and releases owned resources", async () => {
		const payloads = new MemoryPayloads()
		const journal = new InMemoryConversationJournal()
		const invocation: ToolInvocationEnvelope = {
			kind: "tool_invocation",
			toolName: "read_file",
			input: { path: "a.ts" },
			functionId: "function-1",
			dlineTid: "block-1",
			presentationId: 1,
			isNativeToolCall: false,
		}
		const invocationRef = await payloads.put(encodeTaskPayload(invocation))
		const revertDiff = vi.fn(async () => undefined)
		const cancelCommand = vi.fn(async () => undefined)
		const options = createProductionToolAdapter({
			payloads,
			journal,
			resources: { revertDiff, cancelCommand },
			surface: createDeniedSurface("detached_domain"),
			service: { execute: async () => ({ content: "file contents" }) },
			scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
		})
		await options.runner.runBlock({ commandId: "command-1", turnId: "turn-1", dlineTid: "block-1", invocationRef })
		const entry = await journal.findByOperation("tool.result:command-1")
		if (!entry?.payloadRef) throw new Error("missing result")
		expect(decodeTaskPayload<ToolResultEnvelope>(await payloads.read(entry.payloadRef))).toEqual({
			kind: "tool_result",
			blockId: "block-1",
			content: "file contents",
		})
		await options.runner.release({ haltId: "halt-1", reason: "cancel" })
		expect(revertDiff).toHaveBeenCalledOnce()
		expect(cancelCommand).toHaveBeenCalledOnce()
	})
})
