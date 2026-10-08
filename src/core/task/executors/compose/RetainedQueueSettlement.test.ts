import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState, type TaskState } from "../../kernel"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../../stores/InMemoryRuntimeStores"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { UserInputEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import { type RetainedBatchIdentity, type RetainedBatchReceipt, RetainedInputJournalBatch } from "./RetainedInputJournalBatch"
import { settleRetainedQueueDeliveries } from "./RetainedQueueSettlement"

async function harness() {
	const payloads = new InMemoryTaskPayloadStore()
	const journal = new InMemoryConversationJournal()
	const refs = await Promise.all(
		[
			{ kind: "user_input", text: "A" } satisfies UserInputEnvelope,
			{ kind: "user_input", text: "B" } satisfies UserInputEnvelope,
		].map((payload) => payloads.put(encodeTaskPayload(payload))),
	)
	const identity: RetainedBatchIdentity = {
		deliveryId: "delivery-1",
		entries: refs.map((payloadRef, index) => ({ entryId: `entry-${index}`, payloadRef })),
	}
	const batches = new RetainedInputJournalBatch(payloads, journal)
	return { payloads, journal, identity, batches }
}

function pendingState(identity: RetainedBatchIdentity, receipt?: RetainedBatchReceipt, withProvider = false): TaskState {
	const base = createInitialTaskState("task-1")
	const delivery = {
		deliveryId: identity.deliveryId,
		point: "tool_round" as const,
		ownerId: "compose-1",
		generation: 0,
	}
	return {
		...base,
		flow: {
			phase: "running",
			compose: {
				commandId: delivery.ownerId,
				originRevision: 1,
				status: receipt ? "completed" : "running",
				admittedEntryIds: identity.entries.map((entry) => entry.entryId),
				...(receipt
					? {
							queueJournalReceipt: {
								deliveryId: receipt.deliveryId,
								entries: receipt.entries,
								journalWatermark: receipt.watermark,
							},
						}
					: {}),
			},
			...(withProvider
				? {
						provider: { commandId: "provider-1", originRevision: 2, status: "cancelled" as const },
					}
				: {}),
		},
		intake: {
			...base.intake,
			queued: identity.entries.map((entry, sequence) => ({
				...entry,
				source: "user" as const,
				mode: "steering" as const,
				sequence,
				state: "uncertain" as const,
				queue: { editing: false, delivery },
			})),
		},
	}
}

describe("settleRetainedQueueDeliveries", () => {
	it("releases a delivery whose compose writer drained before staging anything", async () => {
		const h = await harness()

		const result = await settleRetainedQueueDeliveries(pendingState(h.identity), h.payloads, h.journal)

		expect(result).toEqual({ decisions: [{ deliveryId: "delivery-1", outcome: "released" }], failures: [] })
	})

	it("atomically retracts a staged batch when no provider terminal fact exists", async () => {
		const h = await harness()
		const receipt = await h.batches.stage({ ...h.identity, generation: 0, signal: new AbortController().signal })

		const result = await settleRetainedQueueDeliveries(pendingState(h.identity, receipt), h.payloads, h.journal)

		expect(result).toEqual({ decisions: [{ deliveryId: "delivery-1", outcome: "released" }], failures: [] })
		expect((await h.journal.project()).visibleMessages).toEqual([])
	})

	it("reconstructs the staged fingerprint by queue sequence rather than physical array order", async () => {
		const h = await harness()
		const receipt = await h.batches.stage({ ...h.identity, generation: 0, signal: new AbortController().signal })
		const state = pendingState(h.identity, receipt)
		const physicallyReversed: TaskState = {
			...state,
			intake: { ...state.intake, queued: [...state.intake.queued].reverse() },
		}

		const result = await settleRetainedQueueDeliveries(physicallyReversed, h.payloads, h.journal)

		expect(result).toEqual({ decisions: [{ deliveryId: "delivery-1", outcome: "released" }], failures: [] })
		expect((await h.journal.project()).visibleMessages).toEqual([])
	})

	it("consumes only a provider terminal fact causally paired with the staged batch receipt", async () => {
		const h = await harness()
		const receipt = await h.batches.stage({ ...h.identity, generation: 0, signal: new AbortController().signal })
		const final = await h.journal.append({
			operationId: "provider.final:provider-1",
			payloadRef: "payload:provider-final",
			source: "provider",
			causation: { commandId: "provider-1", originRevision: 2, generation: 0 },
		})

		const result = await settleRetainedQueueDeliveries(pendingState(h.identity, receipt, true), h.payloads, h.journal)

		expect(result).toEqual({
			decisions: [{ deliveryId: "delivery-1", outcome: "consumed", journalWatermark: final.watermark }],
			failures: [],
		})
		expect((await h.journal.project()).visibleMessages).toHaveLength(2)
	})

	it("keeps the delivery uncertain when a provider terminal fact has no matching batch receipt", async () => {
		const h = await harness()
		await h.batches.stage({ ...h.identity, generation: 0, signal: new AbortController().signal })
		await h.journal.append({
			operationId: "provider.interrupted:provider-1",
			payloadRef: "payload:provider-interrupted",
			source: "provider",
			causation: { commandId: "provider-1", originRevision: 2, generation: 0 },
		})

		const result = await settleRetainedQueueDeliveries(pendingState(h.identity, undefined, true), h.payloads, h.journal)

		expect(result.decisions).toEqual([])
		expect(result.failures).toEqual([{ deliveryId: "delivery-1", message: "RetainedProviderCausationUnproven" }])
		expect((await h.journal.project()).visibleMessages).toHaveLength(2)
	})

	it("does not release when the atomic retraction cannot be made durable", async () => {
		const h = await harness()
		const receipt = await h.batches.stage({ ...h.identity, generation: 0, signal: new AbortController().signal })
		vi.spyOn(h.journal, "tombstone").mockRejectedValueOnce(new Error("disk unavailable"))

		const result = await settleRetainedQueueDeliveries(pendingState(h.identity, receipt), h.payloads, h.journal)

		expect(result.decisions).toEqual([])
		expect(result.failures).toEqual([{ deliveryId: "delivery-1", message: "disk unavailable" }])
		expect((await h.journal.project()).visibleMessages).toHaveLength(1)
	})
})
