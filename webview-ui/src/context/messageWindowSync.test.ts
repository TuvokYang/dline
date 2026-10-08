import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"

import { canAppendRealtimeMessage, isMessageWindowOverfull, reconcileMessageWindow } from "./messageWindowSync"

/**
 * Build a minimal message identified by its timestamp.
 *
 * @param ts Message timestamp.
 * @param partial Whether the message is a streaming frame.
 * @returns Message usable by the reconciliation contract.
 */
function message(ts: number, partial?: boolean): UiMessage {
	return { ts, type: "say", say: "text", text: `m${ts}`, partial } as UiMessage
}

describe("reconcileMessageWindow", () => {
	it("adopts the fetched absolute start when the local window is empty", () => {
		const fetchedMessages = [message(1001), message(1002)]

		const result = reconcileMessageWindow(
			{ messages: [], startIndex: 0 },
			{ messages: fetchedMessages, startIndex: 1001, total: 1201 },
		)

		expect(result.messages).toBe(fetchedMessages)
		expect(result.startIndex).toBe(1001)
		expect(result.removed).toBe(false)
	})

	it("drops a message the backend removed inside the fetched span", () => {
		const result = reconcileMessageWindow(
			{ messages: [message(1), message(2), message(3)], startIndex: 0 },
			{ messages: [message(1), message(3)], startIndex: 0, total: 2 },
		)

		expect(result.messages.map((entry) => entry.ts)).toEqual([1, 3])
		expect(result.removed).toBe(true)
	})

	it("drops deleted local tail rows when the fetched window reaches the backend tail", () => {
		const result = reconcileMessageWindow(
			{ messages: [message(1), message(2), message(3), message(4)], startIndex: 0 },
			{ messages: [message(1), message(2)], startIndex: 0, total: 2 },
		)

		expect(result.messages.map((entry) => entry.ts)).toEqual([1, 2])
		expect(result.removed).toBe(true)
	})

	it("preserves a durable row that arrived after the fetched snapshot started", () => {
		const result = reconcileMessageWindow(
			{ messages: [message(1), message(2), message(3)], startIndex: 0 },
			{ messages: [message(1), message(2)], startIndex: 0, total: 2 },
			{ localTimestampsAtFetchStart: new Set([1, 2]) },
		)

		expect(result.messages.map((entry) => entry.ts)).toEqual([1, 2, 3])
		expect(result.removed).toBe(false)
	})

	it("preserves a partial that arrived after the fetched snapshot started", () => {
		const result = reconcileMessageWindow(
			{ messages: [message(1), message(2), message(3, true)], startIndex: 0 },
			{ messages: [message(1), message(4)], startIndex: 0, total: 2 },
			{ localTimestampsAtFetchStart: new Set([1, 2]) },
		)

		expect(result.messages.map((entry) => entry.ts)).toEqual([1, 3, 4])
		expect(result.removed).toBe(true)
	})

	it("preserves an already visible partial while the task is still streaming", () => {
		const result = reconcileMessageWindow(
			{ messages: [message(1), message(2), message(3, true)], startIndex: 0 },
			{ messages: [message(1), message(4)], startIndex: 0, total: 2 },
			{ localTimestampsAtFetchStart: new Set([1, 2, 3]), preserveOmittedPartials: true },
		)

		expect(result.messages.map((entry) => entry.ts)).toEqual([1, 3, 4])
	})

	it("keeps a restore that truncated the tail and appended a new message", () => {
		// Restore removed ts=3 and appended ts=4, so the total is unchanged and
		// only the fetched span can reveal the deletion.
		const result = reconcileMessageWindow(
			{ messages: [message(1), message(2), message(3)], startIndex: 0 },
			{ messages: [message(1), message(2), message(4)], startIndex: 0, total: 3 },
		)

		expect(result.messages.map((entry) => entry.ts)).toEqual([1, 2, 4])
		expect(result.removed).toBe(true)
	})

	it("preserves local messages older than the fetched span", () => {
		const result = reconcileMessageWindow(
			{ messages: [message(1), message(2), message(5)], startIndex: 10 },
			{ messages: [message(5), message(6)], startIndex: 12, total: 14 },
		)

		expect(result.messages.map((entry) => entry.ts)).toEqual([1, 2, 5, 6])
		expect(result.removed).toBe(false)
	})

	it("refuses to merge disjoint windows into a fake contiguous slice", () => {
		const local = { messages: [message(1), message(2)], startIndex: 0 }

		const result = reconcileMessageWindow(local, {
			messages: [message(900), message(901)],
			startIndex: 900,
			total: 1_000,
		})

		expect(result.messages).toBe(local.messages)
		expect(result.startIndex).toBe(0)
		expect(result.removed).toBe(false)
	})

	it("moves the window start back to cover preserved leading messages", () => {
		const result = reconcileMessageWindow(
			{ messages: [message(1), message(2), message(5)], startIndex: 10 },
			{ messages: [message(5), message(6)], startIndex: 12, total: 14 },
		)

		expect(result.startIndex).toBe(10)
	})

	it("replaces a local partial with the durable fetched message", () => {
		const result = reconcileMessageWindow(
			{ messages: [message(1), message(2, true)], startIndex: 0 },
			{ messages: [message(1), message(2)], startIndex: 0, total: 2 },
		)

		expect(result.messages.map((entry) => entry.partial)).toEqual([undefined, undefined])
	})

	it("does not let a slow response overwrite a newer durable local message", () => {
		// The realtime stream already upgraded ts=2 to an ask; a fetch that was
		// in flight before that must not push the older say back on screen.
		const durableAsk = { ts: 2, type: "ask", ask: "completion_result", text: "Completed" } as UiMessage
		const staleSay = { ts: 2, type: "say", say: "completion_result", text: "Completed" } as UiMessage

		const result = reconcileMessageWindow(
			{ messages: [message(1), durableAsk], startIndex: 0 },
			{ messages: [message(1), staleSay], startIndex: 0, total: 2 },
		)

		expect(result.messages[1]).toBe(durableAsk)
		expect(result.removed).toBe(false)
	})

	it("clears the window when the backend reports an empty conversation", () => {
		const result = reconcileMessageWindow(
			{ messages: [message(1)], startIndex: 0 },
			{ messages: [], startIndex: 0, total: 0 },
		)

		expect(result.messages).toEqual([])
		expect(result.startIndex).toBe(0)
		expect(result.removed).toBe(true)
	})

	it("treats an empty answer for a non-empty conversation as no information", () => {
		const local = { messages: [message(1), message(2)], startIndex: 0 }

		const result = reconcileMessageWindow(local, { messages: [], startIndex: 40, total: 40 })

		expect(result.messages).toBe(local.messages)
		expect(result.removed).toBe(false)
	})
})

describe("canAppendRealtimeMessage", () => {
	it("accepts the live tail when state is current or one message ahead", () => {
		expect(canAppendRealtimeMessage(200, 800, 1_000)).toBe(true)
		expect(canAppendRealtimeMessage(200, 800, 1_001)).toBe(true)
	})

	it("rejects a realtime tail append into an older browsing window", () => {
		expect(canAppendRealtimeMessage(200, 0, 1_000)).toBe(false)
	})
})

describe("isMessageWindowOverfull", () => {
	it("detects a window claiming more messages than the backend holds", () => {
		expect(isMessageWindowOverfull(10, 0, 9)).toBe(true)
	})

	it("accepts a window that fits the reported total", () => {
		expect(isMessageWindowOverfull(10, 0, 10)).toBe(false)
		expect(isMessageWindowOverfull(10, 30, 40)).toBe(false)
	})
})
