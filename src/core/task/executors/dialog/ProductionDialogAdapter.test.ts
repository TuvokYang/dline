import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState, type DialogCommand } from "../../kernel"
import { InMemoryConversationJournal, InMemoryTaskViewPort, type TaskPayloadStore } from "../../stores"
import { decodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import { ProductionDialogAdapter } from "./ProductionDialogAdapter"

/** Content-addressed like the production store, so an identical body keeps one reference. */
class MemoryPayloads implements TaskPayloadStore {
	private readonly values = new Map<string, Uint8Array>()
	async put(payload: Uint8Array): Promise<string> {
		const ref = `sha256:${createHash("sha256").update(payload).digest("hex")}`
		this.values.set(ref, payload)
		return ref
	}
	async read(ref: string): Promise<Uint8Array> {
		const value = this.values.get(ref)
		if (!value) throw new Error(`MissingPayload:${ref}`)
		return value
	}
}

const base = {
	commandId: "dialog-1",
	originRevision: 1,
	generation: 0,
	interactionId: "interaction-1",
	turnId: "turn-1",
	kind: "followup",
	presentationRef: "payload:question-1",
	actionRules: [{ actionId: "reply", payloadPolicy: "draft" as const }],
	prepareKey: "dialog.prepare:interaction-1",
}

function prepare(
	signal = new AbortController().signal,
): Extract<DialogCommand, { type: "dialog.prepare" }> & { signal: AbortSignal } {
	return { ...base, type: "dialog.prepare", signal }
}

function reveal(
	signal = new AbortController().signal,
): Extract<DialogCommand, { type: "dialog.reveal" }> & { signal: AbortSignal } {
	return {
		...base,
		commandId: "dialog-2",
		originRevision: 2,
		type: "dialog.reveal",
		journalRef: "journal:1",
		receiverGeneration: 0,
		revealKey: "dialog.reveal:interaction-1:0",
		signal,
	}
}

describe("ProductionDialogAdapter", () => {
	it("persists prepare idempotently and reveals through the task view", async () => {
		const journal = new InMemoryConversationJournal()
		const taskView = new InMemoryTaskViewPort()
		const state = createInitialTaskState("task-1")
		const adapter = new ProductionDialogAdapter({
			taskId: "task-1",
			journal,
			payloads: new MemoryPayloads(),
			taskView,
			readState: () => state,
		})

		await expect(adapter.prepare(prepare())).resolves.toMatchObject({
			journalRef: "journal:1",
			journalWatermark: { seq: 1 },
			receiverGeneration: 0,
			disposition: "created",
		})
		await expect(adapter.prepare(prepare())).resolves.toMatchObject({ disposition: "existing" })
		await expect(adapter.reveal(reveal())).resolves.toEqual({ disposition: "revealed" })
		await expect(adapter.reveal(reveal())).resolves.toEqual({ disposition: "already_revealed" })
		expect(taskView.transient).toEqual([
			expect.objectContaining({
				taskId: "task-1",
				projection: expect.objectContaining({ kind: "dialog_reveal", interactionId: "interaction-1" }),
			}),
		])
	})

	it("stores a presentation body so the journal always references durable content", async () => {
		// An approval is planned from the turn, so its presentation arrives as the
		// body. Writing that body straight into the journal made the next provider
		// request reject the reference and fail the whole turn.
		const journal = new InMemoryConversationJournal()
		const payloads = new MemoryPayloads()
		const state = createInitialTaskState("task-1")
		const adapter = new ProductionDialogAdapter({
			taskId: "task-1",
			journal,
			payloads,
			taskView: new InMemoryTaskViewPort(),
			readState: () => state,
		})

		await adapter.prepare(prepare())

		const entry = await journal.findByOperation(base.prepareKey)
		expect(entry?.payloadRef).toMatch(/^sha256:[a-f0-9]{64}$/)
		expect(decodeTaskPayload(await payloads.read(entry?.payloadRef ?? ""))).toMatchObject({
			kind: "dialog_presentation",
			presentationKind: "followup",
			body: "payload:question-1",
		})
	})

	it("keeps an existing content-addressed presentation reference", async () => {
		const journal = new InMemoryConversationJournal()
		const payloads = new MemoryPayloads()
		const state = createInitialTaskState("task-1")
		const storedRef = `sha256:${"a".repeat(64)}`
		const adapter = new ProductionDialogAdapter({
			taskId: "task-1",
			journal,
			payloads,
			taskView: new InMemoryTaskViewPort(),
			readState: () => state,
		})

		await adapter.prepare({ ...prepare(), presentationRef: storedRef })

		expect((await journal.findByOperation(base.prepareKey))?.payloadRef).toBe(storedRef)
	})

	it("writes the anchor row once, before the reveal is projected", async () => {
		const journal = new InMemoryConversationJournal()
		const taskView = new InMemoryTaskViewPort()
		const state = createInitialTaskState("task-1")
		// The surface refuses to answer a dialog whose row is missing, so the
		// anchor has to exist before the projection announces the reveal.
		let transientCountAtAnchor = -1
		const writeAnchor = vi.fn(async () => {
			transientCountAtAnchor = taskView.transient.length
		})
		const adapter = new ProductionDialogAdapter({
			taskId: "task-1",
			journal,
			payloads: new MemoryPayloads(),
			taskView,
			readState: () => state,
			writeAnchor,
		})

		await adapter.prepare(prepare())
		await adapter.reveal(reveal())
		await adapter.reveal(reveal())

		expect(writeAnchor).toHaveBeenCalledOnce()
		expect(writeAnchor).toHaveBeenCalledWith({
			interactionId: "interaction-1",
			kind: "followup",
			body: "payload:question-1",
		})
		expect(transientCountAtAnchor).toBe(0)
		expect(taskView.transient).toHaveLength(1)
	})
})
