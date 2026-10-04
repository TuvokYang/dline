import { describe, expect, it, vi } from "vitest"
import type { TaskState } from "../../kernel"
import { createInitialTaskState } from "../../kernel"
import type { TaskPayloadStore } from "../../stores/contracts"
import { InMemoryConversationJournal } from "../../stores/InMemoryRuntimeStores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import { ProductionComposeAdapter } from "./ProductionComposeAdapter"

/** Minimal payload store: content-addressing is irrelevant to round composition. */
function payloadStore(): TaskPayloadStore & { contents: Map<string, Uint8Array> } {
	const contents = new Map<string, Uint8Array>()
	return {
		contents,
		async put(payload) {
			const ref = `ref-${contents.size + 1}`
			contents.set(ref, payload)
			return ref
		},
		async read(payloadRef) {
			const payload = contents.get(payloadRef)
			if (!payload) throw new Error(`MissingPayload:${payloadRef}`)
			return payload
		},
	}
}

/** A state holding one admitted entry, which every composed round needs. */
function stateWithEntry(payloadRef: string): TaskState {
	const base = createInitialTaskState("task-1")
	return {
		...base,
		intake: {
			...base.intake,
			queued: [
				{
					entryId: "entry-1",
					payloadRef,
					source: "user",
					mode: "queued",
					sequence: 1,
					state: "accepted",
				},
			],
		},
	}
}

async function journaledKinds(journal: InMemoryConversationJournal, store: ReturnType<typeof payloadStore>) {
	const projection = await journal.project()
	return projection.visibleMessages.map((entry) => {
		const payload = entry.payloadRef ? store.contents.get(entry.payloadRef) : undefined
		return payload ? (decodeTaskPayload(payload) as { kind: string }).kind : "unknown"
	})
}

describe("ProductionComposeAdapter background results", () => {
	it("keeps retained steering order and preserves per-input authority in model-only projections", async () => {
		const store = payloadStore()
		const journal = new InMemoryConversationJournal()
		const a = await store.put(
			encodeTaskPayload({
				kind: "user_input",
				text: "raw A",
				admittedText: "expanded A",
				explicitInstructions: [{ token: "A" }],
			}),
		)
		const b = await store.put(
			encodeTaskPayload({
				kind: "user_input",
				text: "raw B",
				admittedText: "expanded B",
				explicitInstructions: [{ token: "B" }],
			}),
		)
		const base = createInitialTaskState("task-1")
		const delivery = {
			deliveryId: "queue:tool_round:compose-1",
			point: "tool_round" as const,
			ownerId: "compose-1",
			generation: 0,
		}
		const state: TaskState = {
			...base,
			intake: {
				...base.intake,
				queued: [
					{
						entryId: "a",
						payloadRef: a,
						source: "user",
						mode: "steering",
						sequence: 1,
						state: "reserved",
						queue: { editing: false, delivery },
					},
					{
						entryId: "b",
						payloadRef: b,
						source: "user",
						mode: "steering",
						sequence: 0,
						state: "reserved",
						queue: { editing: false, delivery },
					},
				],
			},
		}
		const adapter = new ProductionComposeAdapter({ payloads: store, journal, readState: () => state })
		const result = await adapter.compose({
			admittedEntryIds: ["b", "a"],
			queueDelivery: delivery,
			signal: new AbortController().signal,
		})
		if (!("draftRef" in result)) throw new Error("Missing provider draft")
		const draft = decodeTaskPayload<{ inputPayloadRefs: string[] }>(await store.read(result.draftRef))
		const payloads = await Promise.all(
			draft.inputPayloadRefs.map(async (ref) =>
				decodeTaskPayload<{ text: string; admittedText: string; explicitInstructions: unknown[] }>(await store.read(ref)),
			),
		)
		expect(payloads.map((payload) => payload.text)).toEqual(["raw B", "raw A"])
		expect(payloads.map((payload) => payload.explicitInstructions)).toEqual([[{ token: "B" }], [{ token: "A" }]])
		expect(payloads.map((payload) => payload.admittedText)).toEqual(["expanded B", "expanded A"])
		expect(decodeTaskPayload<{ admittedText: string }>(await store.read(b)).admittedText).toBe("expanded B")
		const staged = (await journal.project()).visibleMessages[0]
		const batch = decodeTaskPayload<{ admittedText: string; retainedInputBatch: { entries: unknown[] } }>(
			await store.read(staged.payloadRef!),
		)
		expect(batch.admittedText).toContain("sent by the user while work was in progress")
		expect(batch.admittedText.indexOf("expanded B")).toBeLessThan(batch.admittedText.indexOf("expanded A"))
		expect(batch.retainedInputBatch.entries).toHaveLength(2)
		expect(result.queueJournalReceipt?.deliveryId).toBe(delivery.deliveryId)
	})

	it("carries accepted queue response lifecycle and authority without appending its model text twice", async () => {
		const store = payloadStore()
		const journal = new InMemoryConversationJournal()
		const ref = await store.put(
			encodeTaskPayload({
				kind: "user_input",
				text: "/compact audit",
				admittedText: "",
				lifecycle: { commandId: "command.compact", premessage: "audit" },
			}),
		)
		const settleBeforeRound = vi.fn(async () => ({ kind: "ready" as const }))
		const adapter = new ProductionComposeAdapter({
			payloads: store,
			journal,
			readState: () => createInitialTaskState("task-1"),
			compactionBarrier: { settleBeforeRound },
		})
		const result = await adapter.compose({
			admittedEntryIds: [],
			respondedQueue: { deliveryId: "response-1", mode: "queued", entries: [{ entryId: "a", payloadRef: ref }] },
			signal: new AbortController().signal,
		})
		expect(settleBeforeRound).toHaveBeenCalledWith(
			expect.objectContaining({ lifecycle: [{ commandId: "command.compact", premessage: "audit" }] }),
		)
		expect(await journaledKinds(journal, store)).toEqual([])
		if (!("draftRef" in result)) throw new Error("Missing provider draft")
		expect(decodeTaskPayload<{ inputPayloadRefs: string[] }>(await store.read(result.draftRef)).inputPayloadRefs).toEqual([
			ref,
		])
	})
	it("composes without a background producer dependency, as a headless assembly does", async () => {
		const store = payloadStore()
		const journal = new InMemoryConversationJournal()
		const entryRef = await store.put(encodeTaskPayload({ kind: "user_input", text: "headless" }))
		const state = stateWithEntry(entryRef)
		const adapter = new ProductionComposeAdapter({ payloads: store, journal, readState: () => state })

		const result = await adapter.compose({ admittedEntryIds: ["entry-1"], signal: new AbortController().signal })

		expect("draftRef" in result && result.draftRef).toBeTruthy()
		expect(await journaledKinds(journal, store)).toEqual(["user_input"])
	})

	it("hands the barrier the lifecycle command an admitted input carries", async () => {
		const store = payloadStore()
		const journal = new InMemoryConversationJournal()
		const entryRef = await store.put(
			encodeTaskPayload({
				kind: "user_input",
				text: "/compact keep the audit",
				lifecycle: { commandId: "command.compact", premessage: "keep the audit" },
			}),
		)
		const state = stateWithEntry(entryRef)
		const seen: unknown[] = []
		const adapter = new ProductionComposeAdapter({
			payloads: store,
			journal,
			readState: () => state,
			compactionBarrier: {
				settleBeforeRound: async (input) => {
					seen.push(input.lifecycle)
					return { kind: "ready" }
				},
			},
		})

		await adapter.compose({ admittedEntryIds: ["entry-1"], signal: new AbortController().signal })

		expect(seen).toEqual([[{ commandId: "command.compact", premessage: "keep the audit" }]])
	})

	it("gives the round up without drafting or journaling anything when the barrier withdraws it", async () => {
		const store = payloadStore()
		const journal = new InMemoryConversationJournal()
		const entryRef = await store.put(encodeTaskPayload({ kind: "user_input", text: "/compact" }))
		const state = stateWithEntry(entryRef)
		const adapter = new ProductionComposeAdapter({
			payloads: store,
			journal,
			readState: () => state,
			compactionBarrier: {
				settleBeforeRound: async () => ({ kind: "withdrawn", reason: "manual_compaction_failed" }),
			},
		})

		const result = await adapter.compose({ admittedEntryIds: ["entry-1"], signal: new AbortController().signal })

		expect(result).toEqual({ withdrawn: { reason: "manual_compaction_failed" } })
		expect(await journaledKinds(journal, store)).toEqual([])
	})
})

describe("ProductionComposeAdapter draft", () => {
	it("records the journal position the round was composed through, not the visible payloads", async () => {
		const store = payloadStore()
		const journal = new InMemoryConversationJournal()
		for (let turn = 1; turn <= 20; turn++) {
			await journal.append({
				operationId: `history:${turn}`,
				payloadRef: await store.put(encodeTaskPayload({ kind: "user_input", text: `turn ${turn}` })),
				source: "intake",
			})
		}
		const entryRef = await store.put(encodeTaskPayload({ kind: "user_input", text: "latest" }))
		const state = stateWithEntry(entryRef)
		const adapter = new ProductionComposeAdapter({
			payloads: store,
			journal,
			readState: () => state,
			environment: { render: async () => "ENVIRONMENT" },
		})

		const result = await adapter.compose({ admittedEntryIds: ["entry-1"], signal: new AbortController().signal })

		if (!("draftRef" in result)) throw new Error("expected a draft")
		const draft = decodeTaskPayload(await store.read(result.draftRef)) as Record<string, unknown>
		// Through the environment block, the last entry this round wrote.
		expect(draft.journalThrough).toEqual(journal.watermark())
		expect(journal.watermark()).toEqual({ seq: 22 })
		expect(draft).not.toHaveProperty("journalPayloadRefs")
		expect(draft.inputPayloadRefs).toEqual([entryRef])
	})
})
