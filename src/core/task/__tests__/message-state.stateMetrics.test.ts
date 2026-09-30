import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import { MessageStateHandler } from "../message-state"
import { TaskMetricsOwner } from "../performance/TaskMetricsOwner"
import type { TaskUsageReader } from "../performance/task-usage-reader"

/**
 * Behavior guard for the metrics aggregate a state publication reads.
 *
 * The aggregation walks every message and re-serializes each paired API
 * request, whose text carries the whole request body. Publications arrive in
 * bursts while the conversation is unchanged, so the aggregate must be computed
 * once per mutation rather than once per push — and it must still be exact,
 * including for an edit that leaves the message count untouched.
 */

interface CountingStore {
	getAll(): ClineMessage[]
	reads: number
}

function createStore(messages: ClineMessage[]): CountingStore {
	return {
		reads: 0,
		getAll(): ClineMessage[] {
			this.reads++
			return messages
		},
	}
}

function apiRequest(ts: number, tokensIn: number, tokensOut: number): ClineMessage {
	return {
		ts,
		type: "say",
		say: "api_req_started",
		text: JSON.stringify({ tokensIn, tokensOut, cost: 0 }),
	} as ClineMessage
}

function createHandler(store: CountingStore, metricsReader?: TaskUsageReader): MessageStateHandler {
	return new MessageStateHandler({
		taskId: "metrics-task",
		ulid: "metrics-ulid",
		taskState: { conversationHistoryDeletedRange: undefined } as never,
		updateTaskHistory: async () => [],
		uiMessage: store as never,
		metricsReader,
	} as never)
}

/** Drive the single mutation funnel without depending on a durable store. */
function bumpRevision(handler: MessageStateHandler): void {
	;(handler as unknown as { emitClineMessagesChanged(change: unknown): void }).emitClineMessagesChanged({
		type: "set",
		messages: [],
		previousMessages: [],
	})
}

describe("MessageStateHandler.readStateMetrics", () => {
	it("uses the metrics owner's complete usage without requiring a working Task", async () => {
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "task", text: "Synthetic Task" },
			apiRequest(2, 10, 20),
			{ ts: 3, type: "say", say: "subagent_usage", text: JSON.stringify({ tokensIn: 5, tokensOut: 6, cost: 0.25 }) },
			{ ts: 4, type: "say", say: "deleted_api_reqs", text: JSON.stringify({ tokensIn: 7, tokensOut: 9, cost: 0.5 }) },
		]
		const owner = new TaskMetricsOwner({ taskId: "metrics-task", readOnly: true })
		const handler = createHandler(createStore(messages), owner.reader)
		try {
			const metrics = handler.readStateMetrics()
			expect(metrics).toMatchObject({ totalTokensIn: 22, totalTokensOut: 35, totalCost: 0.75 })
			expect(owner.reader.getSnapshot()).toMatchObject(metrics)
			expect(await owner.reader.readUsageSummary()).toEqual(metrics)

			messages[2] = { ...messages[2], text: JSON.stringify({ tokensIn: 8, tokensOut: 10, cost: 0.75 }) }
			bumpRevision(handler)
			expect(handler.readStateMetrics()).toMatchObject({ totalTokensIn: 25, totalTokensOut: 39, totalCost: 1.25 })
			expect(await owner.reader.readUsageSummary()).toMatchObject({
				totalTokensIn: 25,
				totalTokensOut: 39,
				totalCost: 1.25,
			})
		} finally {
			await owner.close()
		}
		await expect(owner.reader.readUsageSummary()).rejects.toThrow("closed")
	})

	it("computes once while the message sequence is unchanged", () => {
		const messages = [apiRequest(1, 10, 20), apiRequest(2, 30, 40)]
		const store = createStore(messages)
		const handler = createHandler(store)

		const first = handler.readStateMetrics()
		const readsAfterFirst = store.reads
		const second = handler.readStateMetrics()
		const third = handler.readStateMetrics()

		expect(first.totalTokensIn).toBe(40)
		expect(first.totalTokensOut).toBe(60)
		// Reusing the aggregate must also stop re-reading the message list: the
		// getter is what a burst would otherwise walk on every push.
		expect(store.reads).toBe(readsAfterFirst)
		expect(second).toBe(first)
		expect(third).toBe(first)
	})

	it("reuses old request usage when unrelated streaming text changes", () => {
		const requestText = JSON.stringify({ request: "synthetic request ".repeat(8_000), tokensIn: 10 })
		const messages: ClineMessage[] = [
			{ ts: 1, type: "say", say: "api_req_started", text: requestText },
			{ ts: 2, type: "say", say: "api_req_finished", text: JSON.stringify({ tokensOut: 20, cacheReads: 0, cost: 0.25 }) },
			{ ts: 3, type: "say", say: "text", partial: true, text: "First chunk" },
		]
		const handler = createHandler(createStore(messages))
		const parse = vi.spyOn(JSON, "parse")
		try {
			const first = handler.readStateMetrics()
			expect(first).toMatchObject({ totalTokensIn: 10, totalTokensOut: 20, totalCacheReads: 0, totalCost: 0.25 })
			for (let chunk = 0; chunk < 3; chunk++) {
				messages[2] = { ...messages[2], text: `Stream chunk ${chunk}` }
				bumpRevision(handler)
				expect(handler.readStateMetrics()).toEqual(first)
			}
			expect(parse.mock.calls.filter(([text]) => text === requestText)).toHaveLength(1)
		} finally {
			parse.mockRestore()
		}
	})

	it("does not serialize request bodies to aggregate paired usage", () => {
		const messages: ClineMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({ request: "synthetic request ".repeat(8_000), tokensIn: 10 }),
			},
			{ ts: 2, type: "say", say: "api_req_finished", text: JSON.stringify({ tokensOut: 20, cost: 0.25 }) },
		]
		const handler = createHandler(createStore(messages))
		const stringify = vi.spyOn(JSON, "stringify")
		try {
			expect(handler.readStateMetrics()).toMatchObject({ totalTokensIn: 10, totalTokensOut: 20, totalCost: 0.25 })
			expect(
				stringify.mock.calls.some(([value]) => value !== null && typeof value === "object" && "request" in value),
			).toBe(false)
		} finally {
			stringify.mockRestore()
		}
	})

	it("recomputes after a mutation that leaves the message count unchanged", () => {
		const messages = [apiRequest(1, 10, 20)]
		const store = createStore(messages)
		const handler = createHandler(store)

		expect(handler.readStateMetrics().totalTokensIn).toBe(10)

		// An in-place edit keeps both the length and the tail identical, which is
		// exactly the shape a count- or tail-based key would fail to notice.
		messages[0] = apiRequest(1, 99, 20)
		bumpRevision(handler)

		expect(handler.readStateMetrics().totalTokensIn).toBe(99)
	})

	it("drops the aggregate when the durable store was written directly", () => {
		const messages = [apiRequest(1, 10, 20)]
		const store = createStore(messages)
		const handler = createHandler(store)

		expect(handler.readStateMetrics().totalTokensIn).toBe(10)

		// Startup clear and checkpoint restore write the store without going
		// through the mutation funnel. Without an explicit invalidation the
		// cached total would outlive the messages it was computed from and the
		// next publication would report the previous task's usage.
		messages.length = 0
		handler.invalidateDerivedAggregates()

		expect(handler.readStateMetrics().totalTokensIn).toBe(0)
	})

	it("keeps the state aggregate separate from the history aggregate", () => {
		// The history row drops the leading task message while a state push
		// reports every message, so a shared slot would let whichever surface
		// read second observe the other's totals.
		const messages = [apiRequest(1, 7, 0), apiRequest(2, 5, 0)]
		const handler = createHandler(createStore(messages))

		const stateMetrics = handler.readStateMetrics()
		const historyMetrics = (
			handler as unknown as { readAggregatedMetrics(all: ClineMessage[]): { totalTokensIn: number } }
		).readAggregatedMetrics(messages)

		expect(stateMetrics.totalTokensIn).toBe(12)
		expect(historyMetrics.totalTokensIn).toBe(5)
		expect(handler.readStateMetrics().totalTokensIn).toBe(12)
	})
})
