import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { projectCompactionContext, readCompletedCompactionCards } from "../compaction-context-projection"
import { compactionSummaryMessage } from "../compaction-summary-message"

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
			compactionSummaryMessage("summary of the old question and answer"),
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

	it("omits tool results whose tool use a completed card summarized while keeping the durable record", () => {
		const history: ClineStorageMessage[] = [
			{ role: "user", content: [{ type: "text", text: "task" }], ts: 1 },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "a", name: "read_file", input: {}, function_id: "call-a" }],
				ts: 2,
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "a", function_id: "call-a", content: "RESULT_A" }],
				ts: 3,
			},
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "b", name: "read_file", input: {}, function_id: "call-b" }],
				ts: 4,
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "b", function_id: "call-b", content: "RESULT_B" },
					{ type: "text", text: "ENV_DETAILS" },
				],
				ts: 5,
			},
		] as ClineStorageMessage[]

		const result = projectCompactionContext({
			canonicalHistory: history,
			completedCards: [card("summary through the protected reads", [0, 3], 3)],
		})

		const projected = JSON.stringify(result.messages)
		expect(projected).toContain("summary through the protected reads")
		expect(projected).toContain("ENV_DETAILS")
		expect(projected).not.toContain("RESULT_B")
		expect(result.canonicalMessageIndexes).toEqual([undefined, 4])
		expect(JSON.stringify(history[4])).toContain("RESULT_B")
	})

	it("skips a message left empty after omitting summarized tool results", () => {
		const history: ClineStorageMessage[] = [
			{ role: "user", content: [{ type: "text", text: "task" }], ts: 1 },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "a", name: "read_file", input: {}, function_id: "dline_function_a" }],
				ts: 2,
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "a", function_id: "dline_function_a", content: "RESULT_A" }],
				ts: 3,
			},
			{ role: "assistant", content: "latest answer", ts: 4 },
		] as ClineStorageMessage[]

		const result = projectCompactionContext({
			canonicalHistory: history,
			completedCards: [card("summary of the read", [0, 1], 1)],
		})

		expect(JSON.stringify(result.messages)).not.toContain("RESULT_A")
		expect(result.canonicalMessageIndexes).toEqual([undefined, 3])
		expect(result.canonicalRanges).toEqual([[3, 3]])
	})

	it("keeps tagged user feedback answering a summarized conversational tool", () => {
		const history: ClineStorageMessage[] = [
			{ role: "user", content: [{ type: "text", text: "task" }], ts: 1 },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "q", name: "qna_respond", input: {}, function_id: "call-q" }],
				ts: 2,
			},
			{
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "q", function_id: "call-q", content: "<feedback>\nTRIGGER\n</feedback>" },
				],
				ts: 3,
			},
		] as ClineStorageMessage[]

		const result = projectCompactionContext({
			canonicalHistory: history,
			completedCards: [card("summary of the answer", [0, 1], 1)],
		})

		expect(JSON.stringify(result.messages)).toContain("TRIGGER")
		expect(result.canonicalMessageIndexes).toEqual([undefined, 2])
	})

	it("keeps results that were already durable when the summary was produced", () => {
		const history: ClineStorageMessage[] = [
			{ role: "user", content: [{ type: "text", text: "task" }], ts: 1 },
			{
				role: "assistant",
				content: [{ type: "tool_use", id: "a", name: "read_file", input: {}, function_id: "call-a" }],
				ts: 2,
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "a", function_id: "call-a", content: "RESULT_A" }],
				ts: 3,
			},
		] as ClineStorageMessage[]

		const result = projectCompactionContext({
			canonicalHistory: history,
			completedCards: [card("summary of the request", [0, 1], 2)],
		})

		// Only results that were still pending at Pass time were part of the summarized source payload.
		expect(JSON.stringify(result.messages)).toContain("RESULT_A")
	})

	it("accumulates surviving completed cards and ordinary deleted ranges", () => {
		const result = projectCompactionContext({
			canonicalHistory: canonical,
			completedCards: [card("first summary", [2, 3], 7), card("second summary", [4, 5], 7)],
			conversationHistoryDeletedRange: [0, 0],
		})

		expect(result.messages).toEqual([
			canonical[1],
			compactionSummaryMessage("first summary"),
			compactionSummaryMessage("second summary"),
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
			compactionSummaryMessage("cumulative summary"),
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
			compactionSummaryMessage("latest summary"),
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
		const messages: ClineMessage[] = [
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
