import { describe, expect, it, vi } from "vitest"
import type { TaskState } from "../../kernel"
import { createInitialTaskState } from "../../kernel"
import { deferred } from "../../runtime/deferred"
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
	it("delivers finished background work in the round it composes", async () => {
		const store = payloadStore()
		const journal = new InMemoryConversationJournal()
		const entryRef = await store.put(encodeTaskPayload({ kind: "user_input", text: "collect" }))
		const state = stateWithEntry(entryRef)
		const commit = vi.fn()
		const adapter = new ProductionComposeAdapter({
			payloads: store,
			journal,
			readState: () => state,
			backgroundResults: {
				collect: vi.fn(async () => ({ text: "# Background Results\n## Background Command Results", commit })),
			},
		})

		await adapter.compose({ admittedEntryIds: ["entry-1"], signal: new AbortController().signal })

		const projection = await journal.project()
		const delivered = projection.visibleMessages
			.map((entry) => (entry.payloadRef ? store.contents.get(entry.payloadRef) : undefined))
			.filter((payload): payload is Uint8Array => payload !== undefined)
			.map((payload) => decodeTaskPayload(payload) as { kind: string; text?: string })
			.find((payload) => payload.kind === "background_results")
		expect(delivered?.text).toContain("# Background Results")
		expect(commit).toHaveBeenCalledOnce()
	})

	it("journals background results after the round's input and before its environment", async () => {
		const store = payloadStore()
		const journal = new InMemoryConversationJournal()
		const entryRef = await store.put(encodeTaskPayload({ kind: "user_input", text: "collect" }))
		const state = stateWithEntry(entryRef)
		const adapter = new ProductionComposeAdapter({
			payloads: store,
			journal,
			readState: () => state,
			backgroundResults: { collect: async () => ({ text: "# Background Results", commit: vi.fn() }) },
			environment: { render: async () => "<environment_details>now</environment_details>" },
		})

		await adapter.compose({ admittedEntryIds: ["entry-1"], signal: new AbortController().signal })

		expect(await journaledKinds(journal, store)).toEqual(["user_input", "background_results", "environment_details"])
	})

	it("keeps collected results pending when the journal append fails", async () => {
		const store = payloadStore()
		const journal = new InMemoryConversationJournal()
		const append = journal.append.bind(journal)
		vi.spyOn(journal, "append").mockImplementation(async (entry) => {
			if (entry.operationId.startsWith("background:")) throw new Error("journal unavailable")
			return append(entry)
		})
		const entryRef = await store.put(encodeTaskPayload({ kind: "user_input", text: "collect" }))
		const state = stateWithEntry(entryRef)
		const commit = vi.fn()
		const adapter = new ProductionComposeAdapter({
			payloads: store,
			journal,
			readState: () => state,
			backgroundResults: { collect: async () => ({ text: "# Background Results", commit }) },
		})

		await expect(adapter.compose({ admittedEntryIds: ["entry-1"], signal: new AbortController().signal })).rejects.toThrow(
			"journal unavailable",
		)
		expect(commit).not.toHaveBeenCalled()
	})

	it("acknowledges a durable result even when cancellation arrives during its append", async () => {
		const store = payloadStore()
		const journal = new InMemoryConversationJournal()
		const append = journal.append.bind(journal)
		const appending = deferred<void>()
		const persisted = deferred<void>()
		vi.spyOn(journal, "append").mockImplementation(async (entry) => {
			if (entry.operationId.startsWith("background:")) {
				appending.resolve()
				await persisted.promise
			}
			return append(entry)
		})
		const entryRef = await store.put(encodeTaskPayload({ kind: "user_input", text: "collect" }))
		const state = stateWithEntry(entryRef)
		const commit = vi.fn()
		const adapter = new ProductionComposeAdapter({
			payloads: store,
			journal,
			readState: () => state,
			backgroundResults: { collect: async () => ({ text: "# Background Results", commit }) },
			environment: { render: async () => "environment" },
		})
		const cancellation = new AbortController()
		const composing = adapter.compose({ admittedEntryIds: ["entry-1"], signal: cancellation.signal })
		const stopped = expect(composing).rejects.toThrow("round cancelled")
		await appending.promise
		expect(commit).not.toHaveBeenCalled()

		cancellation.abort(new Error("round cancelled"))
		persisted.resolve()
		await stopped

		expect(commit).toHaveBeenCalledOnce()
		expect(await journaledKinds(journal, store)).toEqual(["user_input", "background_results"])
	})

	it("stays silent when no background work finished", async () => {
		const store = payloadStore()
		const journal = new InMemoryConversationJournal()
		const entryRef = await store.put(encodeTaskPayload({ kind: "user_input", text: "plain" }))
		const state = stateWithEntry(entryRef)
		const adapter = new ProductionComposeAdapter({
			payloads: store,
			journal,
			readState: () => state,
			backgroundResults: { collect: async () => undefined },
		})

		await adapter.compose({ admittedEntryIds: ["entry-1"], signal: new AbortController().signal })

		expect(await journaledKinds(journal, store)).toEqual(["user_input"])
	})

	it("composes without a background port, as a headless assembly does", async () => {
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
