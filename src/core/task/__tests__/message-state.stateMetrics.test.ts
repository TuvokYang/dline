import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { MessageStateHandler } from "../message-state"

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

function createHandler(store: CountingStore): MessageStateHandler {
	return new MessageStateHandler({
		taskId: "metrics-task",
		ulid: "metrics-ulid",
		taskState: { conversationHistoryDeletedRange: undefined } as never,
		updateTaskHistory: async () => [],
		uiMessage: store as never,
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
