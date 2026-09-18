import { resolveChatRestoreBoundary } from "@integrations/checkpoints/chat-restore-boundary"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { MessageStateHandler } from "../message-state"
import { TaskState } from "../TaskState"

/**
 * P0 regression guard for a Restore rejected by an in-flight compaction card.
 *
 * Restore truncates the durable UI store, but the boundary was resolved from the
 * merged view that also carries transient presentation overlays. A compaction card
 * that had not reached its durable commit therefore made the loaded length disagree
 * with the durable count, and the staleness check rejected the whole restore. The
 * card stayed rendered because no truncation ever ran.
 */

interface DurableRow {
	ts: number
	partial: boolean
}

/** Minimal durable UI store exposing only what restore and the handler consume. */
function createUiMessageStub(rows: DurableRow[]) {
	const durable = [...rows]
	return {
		getAll: () => durable as unknown as ClineMessage[],
		get count() {
			return durable.length
		},
		getByTs: (ts: number) => durable.find((row) => row.ts === ts),
		findIndexByTs: (ts: number) => durable.findIndex((row) => row.ts === ts),
		appendDurable: async (message: ClineMessage) => {
			durable.push(message as unknown as DurableRow)
			return message
		},
		updateMessage: async (index: number, updates: Partial<ClineMessage>) => {
			const updated = { ...durable[index], ...updates } as unknown as DurableRow
			durable[index] = updated
			return updated as unknown as ClineMessage
		},
		flush: async () => {},
		truncateByLineNum: async (count: number) => {
			durable.length = Math.min(durable.length, count)
		},
	}
}

function createHandler(rows: DurableRow[]) {
	const uiMessage = createUiMessageStub(rows)
	const handler = new MessageStateHandler({
		taskId: "task-restore-transient",
		ulid: "ulid-restore-transient",
		updateTaskHistory: async () => [],
		taskState: new TaskState(),
		uiMessage: uiMessage as never,
	})
	return { handler, uiMessage }
}

function compactionCard(ts: number, partial: boolean): ClineMessage {
	return {
		ts,
		type: "say",
		say: "tool",
		partial,
		text: JSON.stringify({
			tool: "summarizeTask",
			content: "",
			compactionStatus: partial ? "receiving" : "failed",
			compactionOperationId: "manual-compact:task-restore-transient:1",
			compactionUnitKind: partial ? "pass" : "failure",
			compactionUnitIndex: 0,
		}),
		conversationHistoryIndex: 1,
	} as ClineMessage
}

describe("chat restore boundary with an in-flight compaction card", () => {
	it("exposes the durable sequence without transient presentation overlays", () => {
		const { handler } = createHandler([
			{ ts: 10, partial: false },
			{ ts: 20, partial: false },
		])

		handler.upsertTransientClineMessage(compactionCard(30, true))

		expect(handler.clineMessages).toHaveLength(3)
		expect(handler.durableClineMessages).toHaveLength(2)
		expect(handler.durableClineMessages.map((message) => message.ts)).toEqual([10, 20])
	})

	it("rejects the restore when the merged view is measured against the durable count", () => {
		const { handler, uiMessage } = createHandler([
			{ ts: 10, partial: false },
			{ ts: 20, partial: false },
		])
		handler.upsertTransientClineMessage(compactionCard(30, true))

		// Reproduces the previous call site: merged messages, durable uiCount.
		expect(() =>
			resolveChatRestoreBoundary({
				messages: handler.clineMessages,
				messageIndex: 1,
				apiCount: 4,
				uiCount: uiMessage.count,
			}),
		).toThrow(/Restore UI history is stale/)
	})

	it("resolves the boundary once the durable sequence is used on both sides", () => {
		const { handler, uiMessage } = createHandler([
			{ ts: 10, partial: false },
			{ ts: 20, partial: false },
		])
		handler.upsertTransientClineMessage(compactionCard(30, true))

		const removed = handler.clearTransientClineMessages()
		expect(removed).toEqual([30])

		const boundary = resolveChatRestoreBoundary({
			messages: handler.durableClineMessages,
			messageIndex: 1,
			apiCount: 4,
			uiCount: uiMessage.count,
		})

		expect(boundary.uiKeepCount).toBe(2)
	})

	it("drops every transient overlay so no compaction card survives the rewind", () => {
		const { handler } = createHandler([{ ts: 10, partial: false }])
		handler.upsertTransientClineMessage(compactionCard(20, true))
		handler.upsertTransientClineMessage(compactionCard(30, true))

		expect(handler.clearTransientClineMessages()).toEqual([20, 30])
		expect(handler.clineMessages.map((message) => message.ts)).toEqual([10])
		expect(handler.clearTransientClineMessages()).toEqual([])
	})

	it("keeps a durably committed compaction card, which restore truncation owns", async () => {
		const { handler } = createHandler([{ ts: 10, partial: false }])
		handler.upsertTransientClineMessage(compactionCard(20, true))
		await handler.commitTransientClineMessage(compactionCard(20, false))

		expect(handler.clearTransientClineMessages()).toEqual([])
		expect(handler.durableClineMessages.map((message) => message.ts)).toEqual([10, 20])
	})

	it("replaces an existing durable row behind a registered history ask", async () => {
		const { handler } = createHandler([{ ts: 10, partial: false }])
		const registered = handler.beginDurableClineMessage({
			ts: 10,
			type: "ask",
			ask: "completion_result",
			text: "done",
			partial: false,
			interactionId: "completion-1",
		})

		expect(handler.clineMessages).toEqual([
			expect.objectContaining({ ts: 10, type: "ask", ask: "completion_result", interactionId: "completion-1" }),
		])

		await registered.persistence
		expect(handler.clearTransientClineMessages()).toEqual([])
		expect(handler.durableClineMessages).toEqual([
			expect.objectContaining({ ts: 10, type: "ask", ask: "completion_result", interactionId: "completion-1" }),
		])
	})
})
