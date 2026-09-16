import type { ClineContent, ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { projectContextCompactionBoundary } from "../context-compaction-boundary"
import { indexLogicalTurns } from "../logical-turns"

function textMessage(role: "user" | "assistant", text: string): ClineStorageMessage {
	return { role, content: [{ type: "text", text }] }
}

function qnaToolUse(functionId: string): ClineStorageMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "tool_use",
				function_id: functionId,
				dline_tid: `tid-${functionId}`,
				name: "qna_respond",
				input: {},
			},
		],
	}
}

function qnaToolResult(functionId: string, feedback: string): ClineStorageMessage {
	return {
		role: "user",
		content: [
			{
				type: "tool_result",
				function_id: functionId,
				dline_tid: `tid-${functionId}`,
				content: [{ type: "text", text: `[qna_respond] Result:\n<feedback>${feedback}</feedback>` }],
			},
		],
	}
}

describe("context compaction boundary", () => {
	it("does not retain a pending-completed side-effect turn after selecting it as compaction source", () => {
		const activeHistory: ClineStorageMessage[] = [
			textMessage("user", "older turn"),
			textMessage("assistant", "older response"),
			textMessage("user", "latest large turn"),
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						function_id: "call-read",
						dline_tid: "tid-call-read",
						name: "read_file",
						input: { path: "LARGE_TOOL_INPUT" },
					},
				],
			},
		]
		const pendingContent: ClineContent[] = [
			{
				type: "tool_result",
				function_id: "call-read",
				dline_tid: "tid-call-read",
				content: [{ type: "text", text: "LARGE_TOOL_RESULT" }],
			},
		]

		const boundary = projectContextCompactionBoundary(activeHistory, pendingContent)
		const sourceText = JSON.stringify(boundary.sourceHistory)
		const continuationText = JSON.stringify(boundary.targetContinuationHistory)

		expect(indexLogicalTurns(boundary.sourceHistory)).toMatchObject({
			turns: [expect.any(Object), expect.any(Object)],
			protectedStartMessageIndex: boundary.sourceHistory.length,
			issues: [],
		})
		expect(sourceText).toContain("latest large turn")
		expect(sourceText).toContain("LARGE_TOOL_INPUT")
		expect(sourceText).toContain("LARGE_TOOL_RESULT")
		expect(continuationText).not.toContain("latest large turn")
		expect(continuationText).not.toContain("LARGE_TOOL_INPUT")
	})

	it("uses protected-tail tool-result identity to keep an earlier turn compressible during explicit retry", () => {
		const activeHistory: ClineStorageMessage[] = [
			textMessage("user", "<task>Turn A</task>"),
			qnaToolUse("call-a"),
			qnaToolResult("call-a", "Turn B request"),
			qnaToolUse("call-b"),
		]
		const pendingContent: ClineContent[] = [{ type: "text", text: "EXPLICIT_RETRY_DRAFT" }]

		const boundary = projectContextCompactionBoundary(activeHistory, pendingContent)
		const sourceText = JSON.stringify(boundary.sourceHistory)
		const continuationText = JSON.stringify(boundary.targetContinuationHistory)

		expect(indexLogicalTurns(boundary.sourceHistory).turns).toHaveLength(1)
		expect(sourceText).toContain("Tool qna_respond executed successfully.")
		expect(sourceText).not.toContain("Turn B request")
		expect(sourceText).not.toContain("EXPLICIT_RETRY_DRAFT")
		expect(continuationText).toContain("Turn B request")
		expect(continuationText).toContain("call-b")
	})
})
