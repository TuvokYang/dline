import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import type { InteractionKind } from "../../interaction/Interaction"
import { getInteraction } from "../../interaction/InteractionRegistry"
import { createInitialTaskState, type TaskEvent, transition } from "../../kernel"
import type { MessageStateHandler } from "../../message-state"
import { InMemoryTaskPayloadStore } from "../../stores/InMemoryRuntimeStores"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { ActiveTaskSession } from "../ActiveTaskSession"
import type { CanonicalQueueTurnEndDelivery } from "../InputQueueApplicationPort"
import { TaskInteractionOwner } from "../TaskInteractionOwner"

function deferred() {
	let resolve!: () => void
	let reject!: (error: Error) => void
	const promise = new Promise<void>((done, failed) => {
		resolve = done
		reject = failed
	})
	return { promise, resolve, reject }
}

async function harness(kind: InteractionKind) {
	const initial = createInitialTaskState("task-1")
	let state = { ...initial, flow: { phase: "running" as const } }
	const responseGate = deferred()
	const runtime = {
		submit: vi.fn(async (event: TaskEvent) => {
			const result = transition(state, event)
			if (result.kind === "rejected") return result
			state = result.state as typeof state
			return {
				kind: "accepted",
				state,
				receipt: { durable: event.type === "dialog.responded" ? responseGate.promise : Promise.resolve() },
			}
		}),
	}
	const payloads = new InMemoryTaskPayloadStore()
	const rows: UiMessage[] = []
	const messages = {
		clineMessages: rows,
		addToClineMessages: vi.fn(async (row: UiMessage) => {
			rows.push(row)
		}),
		finalizeClineMessage: vi.fn(),
		flushUiMessages: vi.fn(async () => undefined),
	} as unknown as MessageStateHandler
	const owner = new TaskInteractionOwner(messages, payloads)
	owner.bind({
		taskId: "task-1",
		state: () => state,
		assembly: { runtime },
		task: {
			respond: async (action: { generation: number }) =>
				runtime.submit({ ...action, type: "dialog.responded" } as TaskEvent),
		},
	} as unknown as ActiveTaskSession)
	const waiting = owner.open({ turnId: "turn-1", interactionId: "dialog-1", kind, presentation: "Question" })
	const outcome = waiting.then(
		(value) => ({ kind: "answered" as const, value }),
		(error: unknown) => ({ kind: "cancelled" as const, error }),
	)
	await vi.waitFor(() => expect(state.dialog.primary).toBeDefined())
	const primary = state.dialog.primary!
	const prepared = await runtime.submit({
		type: "dialog.prepared",
		generation: 0,
		interactionId: "dialog-1",
		commandId: primary.prepare!.commandId,
		originRevision: primary.prepare!.originRevision,
		journalRef: "journal:0",
		journalWatermark: { seq: 0 },
		receiverGeneration: 0,
	})
	if (prepared.kind !== "accepted") throw new Error("Prepare rejected")
	const reveal = state.dialog.primary!.reveal!
	await runtime.submit({
		type: "dialog.presented",
		generation: 0,
		interactionId: "dialog-1",
		commandId: reveal.commandId,
		originRevision: reveal.originRevision,
	})
	const payloadRef = await payloads.put(
		encodeTaskPayload({ kind: "user_input", text: "RAW_TEXT", images: ["raw-image"], files: ["raw-file"] }),
	)
	await runtime.submit({ type: "input_queue.enqueued", generation: 0, entryId: "entry-1", payloadRef })
	await runtime.submit({
		type: "input_queue.delivery_reserved",
		generation: 0,
		deliveryId: "delivery-1",
		ownerId: "dialog-1",
		point: "turn_end",
	})
	const delivery: CanonicalQueueTurnEndDelivery = {
		deliveryId: "delivery-1",
		generation: 0,
		mode: "queued",
		entries: [{ entryId: "entry-1", payloadRef }],
		interaction: { turnId: "turn-1", interactionId: "dialog-1", kind },
		modelDraft: { text: "MODEL_ONLY_GUIDANCE", images: ["raw-image"], files: ["raw-file"] },
		presentationDraft: { text: "RAW_TEXT", images: ["raw-image"], files: ["raw-file"] },
	}
	return { owner, runtime, state: () => state, responseGate, rows, delivery, outcome }
}

const kinds: InteractionKind[] = [
	"followup",
	"make_plan",
	"qna_response",
	"generate_report",
	"status_acknowledgment",
	"completion",
]

describe("live retained dialog response", () => {
	it.each(kinds)("uses the %s action and waits for the response receipt before displaying or resolving", async (kind) => {
		const h = await harness(kind)
		const delivery = h.owner.deliverTurnEnd(h.delivery)
		await vi.waitFor(() => expect(h.state().dialog.primary?.acceptedResponse).toBeDefined())
		expect(h.state().dialog.primary?.acceptedResponse?.actionId).toBe(getInteraction(kind).input.enterAction ?? "reply")
		expect(h.rows.filter((row) => row.say === "user_feedback")).toEqual([])
		h.responseGate.resolve()
		await expect(delivery).resolves.toBe("accepted")
		await expect(h.outcome).resolves.toMatchObject({
			kind: "answered",
			value: { feedbackPresented: true, draft: { text: "MODEL_ONLY_GUIDANCE" } },
		})
		expect(h.rows.filter((row) => row.say === "user_feedback")).toEqual([
			expect.objectContaining({
				text: "RAW_TEXT",
				images: ["raw-image"],
				files: ["raw-file"],
				interactionId: "delivery-1",
			}),
		])
		expect(h.state().intake.queued[0]?.state).toBe("consumed")
		expect(h.state().dialog.primary?.acceptedResponse?.queuedInput?.deliveryId).toBe("delivery-1")
		expect(h.runtime.submit.mock.calls.some(([event]) => event.type === "dialog.resolved")).toBe(false)
	})

	it("does not revive a cancelled receiver after a response was accepted but its receipt was still pending", async () => {
		const h = await harness("completion")
		const delivery = h.owner.deliverTurnEnd(h.delivery)
		await vi.waitFor(() => expect(h.state().dialog.primary?.acceptedResponse).toBeDefined())
		await h.runtime.submit({ type: "user.cancel", generation: 0, haltId: "cancel-1" })
		h.owner.suspend("dialog_cancel")
		h.responseGate.resolve()
		await expect(delivery).resolves.toBe("accepted")
		await expect(h.outcome).resolves.toMatchObject({ kind: "cancelled" })
		expect(h.state().generation).toBe(1)
		expect(h.state().intake.queued[0]?.state).toBe("consumed")
		expect(h.runtime.submit.mock.calls.some(([event]) => event.type === "dialog.resolved")).toBe(false)
	})

	it("withholds a response with a failed durable receipt instead of resolving or returning it to the queue", async () => {
		const h = await harness("completion")
		const delivery = h.owner.deliverTurnEnd(h.delivery)
		await vi.waitFor(() => expect(h.state().dialog.primary?.acceptedResponse).toBeDefined())
		h.responseGate.reject(new Error("snapshot write failed"))
		await expect(delivery).resolves.toBe("uncertain")
		expect(h.rows.filter((row) => row.say === "user_feedback")).toEqual([])
		expect(h.state().intake.queued[0]?.state).toBe("consumed")
		h.owner.dispose()
		await expect(h.outcome).resolves.toMatchObject({ kind: "cancelled" })
	})
})
