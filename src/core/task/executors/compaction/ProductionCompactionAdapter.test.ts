import { describe, expect, it } from "vitest"
import type { TaskPayloadStore } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { CompactionContextEnvelope, CompactionResultEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { CompactionReviewWithdrawnError, ProductionCompactionAdapter } from "./ProductionCompactionAdapter"

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

	it("lands the span the request fixed, not whatever the conversation holds when the summary returns", async () => {
		const payloads = new MemoryPayloads()
		const span = { from: { epoch: 0, seq: 2 }, to: { epoch: 0, seq: 4 } }
		const context: CompactionContextEnvelope = { kind: "compaction_context", span, context: { sourceHistory: [] } }
		const contextRef = await payloads.put(encodeTaskPayload(context))
		const landed: unknown[] = []
		const adapter = new ProductionCompactionAdapter({
			payloads,
			service: { run: async () => ({ summary: "condensed" }) },
			landing: { land: async (input) => void landed.push(input) },
		})

		await adapter.run({
			compactionId: "compact-1",
			attempt: "attempt-1",
			contextRef,
			signal: new AbortController().signal,
			publish: () => undefined,
		})

		// The run's signal travels with the landing so its commit point can refuse a stopped run.
		expect(landed).toEqual([
			{ compactionId: "compact-1", attempt: "attempt-1", summary: "condensed", span, signal: expect.any(AbortSignal) },
		])
	})

	it("lands a manual summary only after the user accepts it, regenerating with their feedback first", async () => {
		const payloads = new MemoryPayloads()
		const context: CompactionContextEnvelope = {
			kind: "compaction_context",
			trigger: "manual",
			context: { sourceHistory: [], guidance: "keep failures" },
		}
		const contextRef = await payloads.put(encodeTaskPayload(context))
		const requests: unknown[] = []
		const reviewed: string[] = []
		const landed: string[] = []
		const decisions = [
			{ action: "regenerate", feedback: "mention the API" } as const,
			{ action: "regenerate", feedback: "" } as const,
			{ action: "accept" } as const,
		]
		const adapter = new ProductionCompactionAdapter({
			payloads,
			service: {
				run: async ({ context: sent }) => {
					requests.push(sent)
					return { summary: `summary ${requests.length}` }
				},
			},
			landing: { land: async (input) => void landed.push(input.summary) },
			review: {
				review: async ({ summary }) => {
					reviewed.push(summary)
					// Nothing may land while the user is still deciding.
					expect(landed).toEqual([])
					return decisions.shift() ?? { action: "accept" }
				},
			},
		})

		await adapter.run({
			compactionId: "compact-1",
			attempt: "attempt-1",
			contextRef,
			signal: new AbortController().signal,
			publish: () => undefined,
		})

		expect(reviewed).toEqual(["summary 1", "summary 2", "summary 3"])
		// A regeneration is a fresh request: the rejected `/compact` guidance and
		// any earlier feedback are never replayed (WS-013 AC-011), and an empty
		// Regenerate asks for a plain summary.
		expect(requests).toEqual([
			{ sourceHistory: [], guidance: "keep failures" },
			{ sourceHistory: [], feedback: "mention the API" },
			{ sourceHistory: [] },
		])
		// Only the accepted summary replaces the conversation.
		expect(landed).toEqual(["summary 3"])
	})

	it("never asks for review of an automatic summary", async () => {
		const payloads = new MemoryPayloads()
		const context: CompactionContextEnvelope = { kind: "compaction_context", context: { sourceHistory: [] } }
		const contextRef = await payloads.put(encodeTaskPayload(context))
		const landed: string[] = []
		const adapter = new ProductionCompactionAdapter({
			payloads,
			service: { run: async () => ({ summary: "automatic" }) },
			landing: { land: async (input) => void landed.push(input.summary) },
			review: { review: async () => expect.unreachable("automatic compaction must not be reviewed") },
		})

		await adapter.run({
			compactionId: "compact-1",
			attempt: "attempt-1",
			contextRef,
			signal: new AbortController().signal,
			publish: () => undefined,
		})

		expect(landed).toEqual(["automatic"])
	})

	it("lands nothing when the run is stopped during review", async () => {
		const payloads = new MemoryPayloads()
		const context: CompactionContextEnvelope = {
			kind: "compaction_context",
			trigger: "manual",
			context: { sourceHistory: [] },
		}
		const contextRef = await payloads.put(encodeTaskPayload(context))
		const controller = new AbortController()
		const landed: string[] = []
		const adapter = new ProductionCompactionAdapter({
			payloads,
			service: { run: async () => ({ summary: "pending" }) },
			landing: { land: async (input) => void landed.push(input.summary) },
			review: {
				review: async () => {
					controller.abort("compaction_cancelled")
					return { action: "accept" }
				},
			},
		})

		await expect(
			adapter.run({
				compactionId: "compact-1",
				attempt: "attempt-1",
				contextRef,
				signal: controller.signal,
				publish: () => undefined,
			}),
		).rejects.toBe("compaction_cancelled")
		expect(landed).toEqual([])
	})

	it("shows a failed run so the unchanged conversation is not mistaken for a condensed one", async () => {
		const payloads = new MemoryPayloads()
		const contextRef = await payloads.put(
			encodeTaskPayload<CompactionContextEnvelope>({
				kind: "compaction_context",
				trigger: "manual",
				context: { sourceHistory: [] },
			}),
		)
		const presented: string[] = []
		const landed: string[] = []
		const adapter = new ProductionCompactionAdapter({
			payloads,
			service: {
				run: async () => {
					throw new Error("Compaction response did not contain summarize_task context")
				},
			},
			landing: { land: async (input) => void landed.push(input.summary) },
			failure: { present: async (input) => void presented.push(`${input.compactionId}/${input.attempt}`) },
		})

		await expect(
			adapter.run({
				compactionId: "compact-1",
				attempt: "attempt-1",
				contextRef,
				signal: new AbortController().signal,
				publish: () => undefined,
			}),
		).rejects.toThrow("summarize_task context")
		expect(presented).toEqual(["compact-1/attempt-1"])
		expect(landed).toEqual([])
	})

	it("presents no failure for a run the user stopped", async () => {
		const payloads = new MemoryPayloads()
		const contextRef = await payloads.put(
			encodeTaskPayload<CompactionContextEnvelope>({
				kind: "compaction_context",
				trigger: "manual",
				context: { sourceHistory: [] },
			}),
		)
		const controller = new AbortController()
		const presented: string[] = []
		const adapter = new ProductionCompactionAdapter({
			payloads,
			service: {
				run: async () => {
					controller.abort("compaction_cancelled")
					throw new Error("aborted mid-stream")
				},
			},
			failure: { present: async (input) => void presented.push(input.compactionId) },
		})

		await expect(
			adapter.run({
				compactionId: "compact-1",
				attempt: "attempt-1",
				contextRef,
				signal: controller.signal,
				publish: () => undefined,
			}),
		).rejects.toThrow("aborted mid-stream")
		expect(presented).toEqual([])
	})

	it("presents no failure when a stop withdrew the review before the run's own signal fired", async () => {
		const payloads = new MemoryPayloads()
		const contextRef = await payloads.put(
			encodeTaskPayload<CompactionContextEnvelope>({
				kind: "compaction_context",
				trigger: "manual",
				context: { sourceHistory: [] },
			}),
		)
		const presented: string[] = []
		const adapter = new ProductionCompactionAdapter({
			payloads,
			service: { run: async () => ({ summary: "pending" }) },
			review: {
				review: async () => {
					throw new CompactionReviewWithdrawnError("dialog_cancel")
				},
			},
			failure: { present: async (input) => void presented.push(input.compactionId) },
		})

		await expect(
			adapter.run({
				compactionId: "compact-1",
				attempt: "attempt-1",
				contextRef,
				signal: new AbortController().signal,
				publish: () => undefined,
			}),
		).rejects.toBeInstanceOf(CompactionReviewWithdrawnError)
		expect(presented).toEqual([])
	})
})
