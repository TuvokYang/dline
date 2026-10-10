import { describe, expect, it, vi } from "vitest"
import { parseDurableToolResult, replayDurableToolResult } from "../../DurableToolResult"
import type { TaskPayloadStore } from "../../stores"
import { InMemoryConversationJournal } from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { DialogDraftEnvelope, ToolInvocationEnvelope, ToolResultEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { createProductionToolAdapter } from "./ProductionToolAdapter"
import { InMemoryToolApprovalFeedbackLedger } from "./ToolApprovalFeedbackLedger"
import { createDeniedSurface } from "./ToolDomainSurface"
import { TurnToolScheduler } from "./TurnToolScheduler"

const INVOCATION: ToolInvocationEnvelope = {
	kind: "tool_invocation",
	toolName: "read_file",
	input: { path: "a.ts" },
	functionId: "function-1",
	dlineTid: "block-1",
	presentationId: 1,
	isNativeToolCall: false,
}

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
		const order = { haltId: "halt-1", reason: "cancel" } as const
		await options.runner.requestStop?.(order)
		await options.runner.release(order)
		expect(revertDiff).toHaveBeenCalledOnce()
		expect(cancelCommand).toHaveBeenCalledOnce()
	})

	// The handler returns attached PDFs with its result; storing each as its own
	// payload is what lets the next request place them after the result.
	it("completes an already-persisted model-facing failed result without writing a duplicate", async () => {
		const payloads = new MemoryPayloads()
		const journal = new InMemoryConversationJournal()
		const invocationRef = await payloads.put(encodeTaskPayload(INVOCATION))
		const options = createProductionToolAdapter({
			payloads,
			journal,
			resources: { revertDiff: async () => undefined, cancelCommand: async () => undefined },
			surface: createDeniedSurface("detached_domain"),
			service: { execute: async () => ({ content: "missing server", failed: true }) },
			scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
		})

		await expect(
			options.runner.runBlock({ commandId: "command-failed", turnId: "turn-1", dlineTid: "block-1", invocationRef }),
		).resolves.toBeUndefined()

		const entry = await journal.findByOperation("tool.result:command-failed")
		if (!entry?.payloadRef) throw new Error("missing failed result")
		expect(decodeTaskPayload<ToolResultEnvelope>(await payloads.read(entry.payloadRef))).toEqual({
			kind: "tool_result",
			blockId: "block-1",
			content: "missing server",
			failed: true,
		})
	})

	it("stores the documents a result carries and references them from the result", async () => {
		const payloads = new MemoryPayloads()
		const journal = new InMemoryConversationJournal()
		const document = {
			type: "attached_document" as const,
			path: "/work/spec.pdf",
			media_type: "application/pdf" as const,
			data: "JVBERi0xLjQKJSVFT0YK",
			byte_length: 16,
			fallback_text: "Hello PDF",
		}
		const options = createProductionToolAdapter({
			payloads,
			journal,
			resources: { revertDiff: async () => undefined, cancelCommand: async () => undefined },
			surface: createDeniedSurface("detached_domain"),
			service: { execute: async () => ({ content: "answered", documents: [document] }) },
			scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
		})

		await options.runner.runBlock({
			commandId: "command-1",
			turnId: "turn-1",
			dlineTid: "block-1",
			invocationRef: await payloads.put(encodeTaskPayload(INVOCATION)),
		})

		const entry = await journal.findByOperation("tool.result:command-1")
		if (!entry?.payloadRef) throw new Error("missing result")
		const result = decodeTaskPayload<ToolResultEnvelope>(await payloads.read(entry.payloadRef))
		expect(result).toMatchObject({ kind: "tool_result", blockId: "block-1", content: "answered" })
		expect(result.documentPayloadRefs).toHaveLength(1)
		expect(decodeTaskPayload(await payloads.read(result.documentPayloadRefs?.[0] ?? ""))).toEqual({
			kind: "attached_document",
			document,
		})
	})

	it("journals the approval feedback its block carries, after the result", async () => {
		// An approval is planned from the turn, so a note typed while approving is
		// not an intake entry; journaling it here is its only route to the provider.
		const payloads = new MemoryPayloads()
		const journal = new InMemoryConversationJournal()
		const approvalFeedback = new InMemoryToolApprovalFeedbackLedger()
		approvalFeedback.record("block-1", { text: "only the header", images: [], files: ["notes.md"] })
		const options = createProductionToolAdapter({
			payloads,
			journal,
			approvalFeedback,
			resources: { revertDiff: async () => undefined, cancelCommand: async () => undefined },
			surface: createDeniedSurface("detached_domain"),
			service: { execute: async () => ({ content: "file contents" }) },
			scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
		})

		await options.runner.runBlock({
			commandId: "command-1",
			turnId: "turn-1",
			dlineTid: "block-1",
			invocationRef: await payloads.put(encodeTaskPayload(INVOCATION)),
		})

		const feedback = await journal.findByOperation("tool.approval_feedback:command-1")
		if (!feedback?.payloadRef) throw new Error("missing approval feedback")
		expect(decodeTaskPayload<DialogDraftEnvelope>(await payloads.read(feedback.payloadRef))).toEqual({
			kind: "dialog_draft",
			text: "only the header",
			images: [],
			files: ["notes.md"],
		})
		const result = await journal.findByOperation("tool.result:command-1")
		expect(result?.watermark.seq).toBeLessThan(feedback.watermark.seq)
		// Consumed by this block, so a later block cannot inherit the instruction.
		expect(approvalFeedback.take("block-1")).toBeUndefined()
	})

	it("consumes the approval feedback even when the tool fails", async () => {
		const payloads = new MemoryPayloads()
		const journal = new InMemoryConversationJournal()
		const approvalFeedback = new InMemoryToolApprovalFeedbackLedger()
		approvalFeedback.record("block-1", { text: "careful here" })
		const options = createProductionToolAdapter({
			payloads,
			journal,
			approvalFeedback,
			resources: { revertDiff: async () => undefined, cancelCommand: async () => undefined },
			surface: createDeniedSurface("detached_domain"),
			service: {
				execute: async () => {
					throw new Error("tool exploded")
				},
			},
			scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
		})

		await expect(
			options.runner.runBlock({
				commandId: "command-1",
				turnId: "turn-1",
				dlineTid: "block-1",
				invocationRef: await payloads.put(encodeTaskPayload(INVOCATION)),
			}),
		).rejects.toThrow("tool exploded")

		expect(await journal.findByOperation("tool.approval_feedback:command-1")).toBeDefined()
		expect(approvalFeedback.take("block-1")).toBeUndefined()
	})

	it("persists a failure as a canonical tool result", async () => {
		// The conversation still owes this block a result. Writing the raw message
		// produced a journal entry the next provider request could not materialize,
		// which failed every later turn of the task.
		const payloads = new MemoryPayloads()
		const journal = new InMemoryConversationJournal()
		const options = createProductionToolAdapter({
			payloads,
			journal,
			resources: { revertDiff: async () => undefined, cancelCommand: async () => undefined },
			surface: createDeniedSurface("detached_domain"),
			service: {
				execute: async () => {
					throw new Error("phase_invalid")
				},
			},
			scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
		})

		await expect(
			options.runner.runBlock({
				commandId: "command-1",
				turnId: "turn-1",
				dlineTid: "block-1",
				invocationRef: await payloads.put(encodeTaskPayload(INVOCATION)),
			}),
		).rejects.toThrow("phase_invalid")

		const entry = await journal.findByOperation("tool.result:command-1")
		if (!entry?.payloadRef) throw new Error("missing result")
		const envelope = decodeTaskPayload<ToolResultEnvelope>(await payloads.read(entry.payloadRef))
		expect(envelope.failed).toBe(true)
		expect(parseDurableToolResult(envelope.content)).toMatchObject({
			type: "tool_result",
			function_id: "function-1",
			dline_tid: "block-1",
			is_error: true,
			content: [{ type: "text", text: "phase_invalid" }],
		})
	})

	it("persists the failure of a call that was never recorded as a result the next request reads as prose", async () => {
		const payloads = new MemoryPayloads()
		const journal = new InMemoryConversationJournal()
		const options = createProductionToolAdapter({
			payloads,
			journal,
			resources: { revertDiff: async () => undefined, cancelCommand: async () => undefined },
			surface: createDeniedSurface("detached_domain"),
			service: {
				execute: async () => {
					throw new Error("phase_invalid")
				},
			},
			scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
		})

		await expect(
			options.runner.runBlock({
				commandId: "command-1",
				turnId: "turn-1",
				dlineTid: "block-1",
				invocationRef: await payloads.put(encodeTaskPayload({ ...INVOCATION, resultReplay: "text" })),
			}),
		).rejects.toThrow("phase_invalid")

		const entry = await journal.findByOperation("tool.result:command-1")
		if (!entry?.payloadRef) throw new Error("missing result")
		const envelope = decodeTaskPayload<ToolResultEnvelope>(await payloads.read(entry.payloadRef))
		expect(replayDurableToolResult(envelope.content)).toEqual([{ type: "text", text: "[read_file] Result:\nphase_invalid" }])
	})

	it("writes no feedback entry when the user approved without typing", async () => {
		const payloads = new MemoryPayloads()
		const journal = new InMemoryConversationJournal()
		const options = createProductionToolAdapter({
			payloads,
			journal,
			approvalFeedback: new InMemoryToolApprovalFeedbackLedger(),
			resources: { revertDiff: async () => undefined, cancelCommand: async () => undefined },
			surface: createDeniedSurface("detached_domain"),
			service: { execute: async () => ({ content: "file contents" }) },
			scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
		})

		await options.runner.runBlock({
			commandId: "command-1",
			turnId: "turn-1",
			dlineTid: "block-1",
			invocationRef: await payloads.put(encodeTaskPayload(INVOCATION)),
		})

		expect(await journal.findByOperation("tool.approval_feedback:command-1")).toBeUndefined()
	})
})
