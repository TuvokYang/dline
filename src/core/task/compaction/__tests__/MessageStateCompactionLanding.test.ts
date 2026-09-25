import type { ClineMessage, ClineSayTool } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import type { MessageStateHandler } from "../../message-state"
import { MessageStateCompactionLanding } from "../MessageStateCompactionLanding"

interface RecordedHistoryEntry {
	readonly role: string
	readonly content: unknown
}

/**
 * The narrow slice of MessageStateHandler the landing actually writes through,
 * with the same `ts` precondition the real handler enforces. A stub that
 * accepted a message without `ts` would pass while production threw.
 */
function createMessageStub(initialHistory: RecordedHistoryEntry[]) {
	const rows: ClineMessage[] = []
	let history = initialHistory
	const handler = {
		get apiConversationHistory() {
			return history
		},
		async overwriteApiConversationHistory(next: RecordedHistoryEntry[]) {
			history = next
		},
		async addToClineMessages(message: Partial<ClineMessage>) {
			if (message.ts === undefined) {
				throw new Error("addToClineMessages: ts is required")
			}
			rows.push(message as ClineMessage)
		},
	}
	return { handler: handler as unknown as MessageStateHandler, rows, readHistory: () => history }
}

function createSequence(start = 1_000): () => number {
	let last = start
	return () => {
		last += 1
		return last
	}
}

describe("MessageStateCompactionLanding", () => {
	it("stamps the card with the shared presentation sequence", async () => {
		const { handler, rows } = createMessageStub([{ role: "user", content: "original task" }])
		const landing = new MessageStateCompactionLanding(handler, createSequence())

		await landing.land({ compactionId: "compaction-1", attempt: "attempt-1", summary: "the summary" })

		expect(rows).toHaveLength(1)
		expect(rows[0].ts).toBe(1_001)
		expect(rows[0].type).toBe("say")
		expect(rows[0].say).toBe("tool")
		expect(rows[0].partial).toBe(false)
	})

	it("writes a completed summarizeTask card carrying the summary and operation identity", async () => {
		const { handler, rows } = createMessageStub([{ role: "user", content: "original task" }])
		const landing = new MessageStateCompactionLanding(handler, createSequence())

		await landing.land({ compactionId: "compaction-7", attempt: "attempt-2", summary: "compressed history" })

		const payload = JSON.parse(rows[0].text ?? "{}") as ClineSayTool
		expect(payload).toMatchObject({
			tool: "summarizeTask",
			content: "compressed history",
			compactionStatus: "completed",
			compactionOperationId: "compaction-7",
			compactionUnitKind: "pass",
			compactionDurable: true,
		})
	})

	it("leaves the legacy API history untouched so a restore can still return to it", async () => {
		const original = [
			{ role: "user", content: "original task" },
			{ role: "assistant", content: "step one" },
			{ role: "user", content: "step two" },
		]
		const { handler, readHistory } = createMessageStub(original)
		const landing = new MessageStateCompactionLanding(handler, createSequence())

		await landing.land({ compactionId: "compaction-1", attempt: "attempt-1", summary: "the summary" })

		// The journal landing condenses what the provider is sent; rewriting these
		// rows would only destroy the pre-compaction record.
		expect(readHistory()).toBe(original)
	})

	it("records the last replaced journal entry as the card's restore boundary", async () => {
		const { handler, rows } = createMessageStub([{ role: "user", content: "original task" }])
		const landing = new MessageStateCompactionLanding(handler, createSequence())

		await landing.land({
			compactionId: "compaction-1",
			attempt: "attempt-1",
			summary: "the summary",
			span: { from: { seq: 2 }, to: { seq: 7 } },
		})

		const payload = JSON.parse(rows[0].text ?? "{}") as ClineSayTool
		expect(payload.compactionJournalBoundary).toEqual({ seq: 7 })
		// The card belongs to the journal conversation, not to API history rows.
		expect(rows[0].compactionConversationRange).toBeUndefined()
	})

	it("offers no restore boundary for a summary that carried no span", async () => {
		const { handler, rows } = createMessageStub([{ role: "user", content: "original task" }])
		const landing = new MessageStateCompactionLanding(handler, createSequence())

		await landing.land({ compactionId: "compaction-1", attempt: "attempt-1", summary: "the summary" })

		const payload = JSON.parse(rows[0].text ?? "{}") as ClineSayTool
		expect(payload.compactionJournalBoundary).toBeUndefined()
	})

	it("advances the sequence per landing so repeated compactions stay ordered", async () => {
		const { handler, rows } = createMessageStub([{ role: "user", content: "original task" }])
		const landing = new MessageStateCompactionLanding(handler, createSequence())

		await landing.land({ compactionId: "compaction-1", attempt: "attempt-1", summary: "first" })
		await landing.land({ compactionId: "compaction-2", attempt: "attempt-1", summary: "second" })

		expect(rows.map((row) => row.ts)).toEqual([1_001, 1_002])
	})
})
