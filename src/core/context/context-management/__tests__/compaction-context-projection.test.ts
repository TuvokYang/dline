import type { UiMessage } from "@shared/ExtensionMessage"
import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { projectCompactionContext, readCompletedCompactionCards } from "../compaction-context-projection"

const canonical: ClineStorageMessage[] = [
	{ role: "user", content: "task", ts: 1 },
	{ role: "assistant", content: "ack", ts: 2 },
	{ role: "user", content: "old question", ts: 3 },
	{ role: "assistant", content: "old answer", ts: 4 },
	{ role: "user", content: "middle question", ts: 5 },
	{ role: "assistant", content: "middle answer", ts: 6 },
	{ role: "user", content: "latest question", ts: 7 },
	{ role: "assistant", content: "latest answer", ts: 8 },
]

describe("projectCompactionContext", () => {
	it("derives provider history from canonical ranges without mutating durable records", () => {
		const result = projectCompactionContext({
			canonicalHistory: canonical,
			completedCards: [card("summary of the old question and answer", [2, 3], 7)],
		})

		expect(result.messages).toEqual([
			canonical[0],
			canonical[1],
			{ role: "user", content: [{ type: "text", text: "summary of the old question and answer" }] },
			canonical[4],
			canonical[5],
			canonical[6],
			canonical[7],
		])
		expect(result.canonicalMessageIndexes).toEqual([0, 1, undefined, 4, 5, 6, 7])
		expect(result.canonicalRanges).toEqual([
			[0, 1],
			[4, 7],
		])
		expect(canonical[2].content).toBe("old question")
	})

	it("accumulates surviving completed cards and ordinary deleted ranges", () => {
		const result = projectCompactionContext({
			canonicalHistory: canonical,
			completedCards: [card("first summary", [2, 3], 7), card("second summary", [4, 5], 7)],
			conversationHistoryDeletedRange: [0, 0],
		})

		expect(result.messages).toEqual([
			canonical[1],
			{ role: "user", content: [{ type: "text", text: "first summary" }] },
			{ role: "user", content: [{ type: "text", text: "second summary" }] },
			canonical[6],
			canonical[7],
		])
		expect(result.canonicalMessageIndexes).toEqual([1, undefined, undefined, 6, 7])
	})

	it("keeps only the latest cumulative card when it contains an earlier card", () => {
		const result = projectCompactionContext({
			canonicalHistory: canonical,
			completedCards: [card("old summary", [2, 3], 7), card("cumulative summary", [2, 5], 7)],
		})

		expect(result.messages).toEqual([
			canonical[0],
			canonical[1],
			{ role: "user", content: [{ type: "text", text: "cumulative summary" }] },
			canonical[6],
			canonical[7],
		])
		expect(result.sourceCanonicalRanges).toEqual([
			[0, 0],
			[1, 1],
			[2, 5],
			[6, 6],
			[7, 7],
		])
	})

	it("lets the latest partially overlapping card win without hiding its uncovered predecessor range", () => {
		const result = projectCompactionContext({
			canonicalHistory: canonical,
			completedCards: [card("old summary", [2, 4], 7), card("latest summary", [4, 5], 7)],
		})

		expect(result.messages).toEqual([
			canonical[0],
			canonical[1],
			canonical[2],
			canonical[3],
			{ role: "user", content: [{ type: "text", text: "latest summary" }] },
			canonical[6],
			canonical[7],
		])
		expect(result.canonicalMessageIndexes).toEqual([0, 1, 2, 3, undefined, 6, 7])
	})

	it("ignores an empty completed card instead of hiding canonical history", () => {
		const result = projectCompactionContext({
			canonicalHistory: canonical,
			completedCards: [card("   ", [2, 3], 7)],
		})

		expect(result.messages).toEqual(canonical)
		expect(result.canonicalMessageIndexes).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
	})
})

describe("readCompletedCompactionCards", () => {
	it("reads only new-format completed cards from the loaded UI cache", () => {
		const messages: UiMessage[] = [
			{
				ts: 10,
				type: "say",
				say: "tool",
				text: JSON.stringify({ tool: "summarizeTask", content: "new summary", compactionStatus: "completed" }),
				compactionConversationRange: {
					logicalTurnRange: [0, 1],
					apiConversationRange: [2, 3],
					preCompactionApiEndIndex: 7,
				},
			},
			{
				ts: 11,
				type: "say",
				say: "tool",
				text: JSON.stringify({
					tool: "summarizeTask",
					content: "legacy summary",
					compactionStatus: "completed",
					compactionPrePassCheckpointId: "sha256:legacy",
				}),
			},
		]

		expect(readCompletedCompactionCards(messages)).toEqual([card("new summary", [2, 3], 7)])
	})
})

function card(summary: string, apiConversationRange: readonly [number, number], preCompactionApiEndIndex: number) {
	return {
		summary,
		range: {
			logicalTurnRange: [0, 1] as const,
			apiConversationRange,
			preCompactionApiEndIndex,
		},
	}
}
