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
	it("delivers finished background work in the round it composes", async () => {
		const store = payloadStore()
		const journal = new InMemoryConversationJournal()
		const entryRef = await store.put(encodeTaskPayload({ kind: "user_input", text: "collect" }))
		const state = stateWithEntry(entryRef)
		const adapter = new ProductionComposeAdapter({
			payloads: store,
			journal,
			readState: () => state,
			backgroundResults: { collect: vi.fn(async () => "# Background Results\n## Background Command Results") },
		})

		await adapter.compose({ admittedEntryIds: ["entry-1"], signal: new AbortController().signal })

		const projection = await journal.project()
		const delivered = projection.visibleMessages
			.map((entry) => (entry.payloadRef ? store.contents.get(entry.payloadRef) : undefined))
			.filter((payload): payload is Uint8Array => payload !== undefined)
			.map((payload) => decodeTaskPayload(payload) as { kind: string; text?: string })
			.find((payload) => payload.kind === "background_results")
		expect(delivered?.text).toContain("# Background Results")
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
			backgroundResults: { collect: async () => "# Background Results" },
			environment: { render: async () => "<environment_details>now</environment_details>" },
		})

		await adapter.compose({ admittedEntryIds: ["entry-1"], signal: new AbortController().signal })

		expect(await journaledKinds(journal, store)).toEqual(["user_input", "background_results", "environment_details"])
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
