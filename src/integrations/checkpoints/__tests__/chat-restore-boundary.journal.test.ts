import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { resolveChatRestoreBoundary } from "../chat-restore-boundary"

function row(ts: number, text: string): ClineMessage {
	return { ts, type: "say", say: "text", text } as ClineMessage
}

function journalCard(ts: number, boundary: unknown, status = "completed"): ClineMessage {
	return {
		ts,
		type: "say",
		say: "tool",
		partial: false,
		text: JSON.stringify({
			tool: "summarizeTask",
			content: "summary",
			compactionStatus: status,
			compactionJournalBoundary: boundary,
		}),
	} as ClineMessage
}

describe("chat restore boundary for a journal-bounded compaction card", () => {
	it("rewinds the journal to the card's boundary and keeps the chat up to the card", () => {
		const messages = [row(1, "task"), row(2, "history"), journalCard(3, { seq: 6 }), row(4, "after")]

		const boundary = resolveChatRestoreBoundary({ messages, messageIndex: 2, apiCount: 2, uiCount: messages.length })

		expect(boundary.journalTarget).toEqual({ seq: 6 })
		expect(boundary.uiKeepCount).toBe(2)
		expect(boundary.contextAnchorTs).toBe(2)
		// API rows are not this conversation's record, so none are truncated.
		expect(boundary.apiKeepCount).toBe(2)
	})

	it("rejects a malformed boundary instead of guessing a position", () => {
		const messages = [row(1, "task"), journalCard(2, { seq: 0 })]

		expect(() => resolveChatRestoreBoundary({ messages, messageIndex: 1, apiCount: 0, uiCount: 2 })).toThrowError(
			"Compaction Restore boundary is inconsistent with the current conversation",
		)
	})

	it("rejects a card with no earlier row to anchor the context history", () => {
		const messages = [journalCard(1, { seq: 3 })]

		expect(() => resolveChatRestoreBoundary({ messages, messageIndex: 0, apiCount: 0, uiCount: 1 })).toThrowError(
			"Compaction Restore boundary is inconsistent with the current conversation",
		)
	})

	it("treats a failed card as an ordinary row even when it carries a boundary", () => {
		const messages = [row(1, "task"), journalCard(2, { seq: 3 }, "failed")]

		const boundary = resolveChatRestoreBoundary({ messages, messageIndex: 1, apiCount: 0, uiCount: 2 })

		expect(boundary.journalTarget).toBeUndefined()
		expect(boundary.uiKeepCount).toBe(2)
	})
})
