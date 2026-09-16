import type { CanonicalMessageRange } from "@core/context/context-management/compaction-context-projection"
import { indexLogicalTurns } from "@core/context/context-management/logical-turns"
import type { ClineStorageMessage, ClineUserToolResultContentBlock } from "@shared/messages"
import type { ClineContent } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { Task } from "../index"

interface BoundaryTaskHarness {
	taskState: {
		userMessageContent: ClineContent[]
		conversationHistoryDeletedRange?: [number, number]
	}
	contextManager: {
		getTruncatedMessages(history: ClineStorageMessage[], deletedRange?: [number, number]): ClineStorageMessage[]
		applyContextHistoryUpdatesToCanonical(history: ClineStorageMessage[]): ClineStorageMessage[]
		repairProviderMessagesWithRanges(
			messages: ClineStorageMessage[],
			canonicalRanges: Array<CanonicalMessageRange | undefined>,
		): { messages: ClineStorageMessage[]; canonicalRanges: Array<CanonicalMessageRange | undefined> }
	}
	messageStateHandler: {
		apiConversationHistory: ClineStorageMessage[]
		clineMessages: []
	}
	getOrdinaryContextCompactionBoundary(pendingContent?: readonly ClineContent[]): {
		sourceHistory: ClineStorageMessage[]
		targetContinuationHistory: ClineStorageMessage[]
	}
	getTaskHeaderContextCompactionBoundary(): {
		sourceHistory: ClineStorageMessage[]
		targetContinuationHistory: ClineStorageMessage[]
	}
}

function createHarness(toolName = "qna_respond"): BoundaryTaskHarness {
	const history: ClineStorageMessage[] = [
		{
			role: "user",
			content: [{ type: "text", text: "first turn" }],
			ts: 1,
		},
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					name: toolName,
					input: { response: "question" },
					dline_tid: "tid-qna",
					function_id: "fn-qna",
				},
			],
			ts: 2,
		},
	]
	const harness = Object.assign(Object.create(Task.prototype), {
		taskState: {
			userMessageContent: [],
			conversationHistoryDeletedRange: undefined,
		},
		contextManager: {
			getTruncatedMessages: (input: ClineStorageMessage[]) => input,
			applyContextHistoryUpdatesToCanonical: (input: ClineStorageMessage[]) => input,
			repairProviderMessagesWithRanges: (
				messages: ClineStorageMessage[],
				canonicalRanges: Array<CanonicalMessageRange | undefined>,
			) => ({ messages, canonicalRanges }),
		},
		messageStateHandler: { apiConversationHistory: history, clineMessages: [] },
	}) as BoundaryTaskHarness
	return harness
}

function pendingToolResult(text = "<feedback>\nuser reply\n</feedback>"): ClineUserToolResultContentBlock {
	return {
		type: "tool_result",
		content: [
			{
				type: "text",
				text,
			},
		],
		dline_tid: "tid-qna",
		function_id: "fn-qna",
	}
}

describe("Task ordinary context compaction boundary", () => {
	it("keeps pending qna feedback outside the compaction source while releasing the protected tail", () => {
		const task = createHarness()
		task.taskState.userMessageContent = [pendingToolResult()]

		const boundary = task.getOrdinaryContextCompactionBoundary()

		expect(boundary.targetContinuationHistory).toEqual([task.messageStateHandler.apiConversationHistory[1]])
		expect(boundary.sourceHistory.length).toBe(3)
		expect(boundary.sourceHistory[1]?.role).toBe("assistant")
		expect(boundary.sourceHistory[2]?.role).toBe("user")
		expect(JSON.stringify(boundary.sourceHistory)).not.toContain("user reply")
	})

	it("uses request-local pending tool results after mutable Task state has been cleared", () => {
		const task = createHarness()
		const requestLocalContent = [pendingToolResult()]

		const boundary = task.getOrdinaryContextCompactionBoundary(requestLocalContent)

		expect(task.taskState.userMessageContent).toEqual([])
		expect(boundary.targetContinuationHistory).toEqual([task.messageStateHandler.apiConversationHistory[1]])
		expect(boundary.sourceHistory.length).toBe(3)
		expect(boundary.sourceHistory[1]?.role).toBe("assistant")
		expect(boundary.sourceHistory[2]?.role).toBe("user")
		expect(JSON.stringify(boundary.sourceHistory)).not.toContain("user reply")
	})

	it("returns a pairing-safe source when pending tagged feedback closes the previous conversational tool", () => {
		const task = createHarness()
		const boundary = task.getOrdinaryContextCompactionBoundary([pendingToolResult()])

		const sourceIndex = indexLogicalTurns(boundary.sourceHistory)
		expect(sourceIndex.turns).toHaveLength(1)
		expect(sourceIndex.protectedStartMessageIndex).toBe(boundary.sourceHistory.length)
		expect(sourceIndex.issues).toEqual([])
		expect(JSON.stringify(boundary.sourceHistory)).not.toContain("user reply")
	})

	it("never duplicates pending tool results into the continuation tail", () => {
		const task = createHarness()
		task.taskState.userMessageContent = [pendingToolResult()]

		const boundary = task.getOrdinaryContextCompactionBoundary()

		const tailResults = boundary.targetContinuationHistory.flatMap((message) =>
			message.role === "user" && Array.isArray(message.content)
				? message.content.filter((block): block is ClineUserToolResultContentBlock => block.type === "tool_result")
				: [],
		)
		expect(tailResults).toEqual([])
	})

	it("keeps the pre-existing tail intact when there are no pending tool results", () => {
		const task = createHarness()
		// Persist the qna tool result canonically, then append an unpaired assistant
		// tool use that legitimately protects the tail.
		task.messageStateHandler.apiConversationHistory.push({
			role: "user",
			content: [pendingToolResult()],
			ts: 3,
		})
		task.messageStateHandler.apiConversationHistory.push({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					name: "attempt_completion",
					input: { result: "done" },
					dline_tid: "tid-attempt",
					function_id: "fn-attempt",
				},
			],
			ts: 4,
		})

		const boundary = task.getOrdinaryContextCompactionBoundary()

		// The real tagged feedback and its assistant response remain protected, while
		// neutral identity evidence keeps the earlier source provider-projectable.
		expect(boundary.sourceHistory.length).toBe(3)
		expect(JSON.stringify(boundary.sourceHistory)).toContain("Tool qna_respond executed successfully.")
		expect(JSON.stringify(boundary.sourceHistory)).not.toContain("user reply")
		expect(boundary.targetContinuationHistory.length).toBe(2)
		expect(boundary.targetContinuationHistory[0]?.role).toBe("user")
		expect(boundary.targetContinuationHistory[1]?.role).toBe("assistant")
	})

	it("keeps pending turn-end feedback outside the compaction source", () => {
		const task = createHarness()
		// Close the qna turn canonically first so only the attempt turn is open.
		task.messageStateHandler.apiConversationHistory.push({
			role: "user",
			content: [pendingToolResult()],
			ts: 3,
		})
		task.messageStateHandler.apiConversationHistory.push({
			role: "assistant",
			content: [
				{
					type: "tool_use",
					name: "attempt_completion",
					input: { result: "done" },
					dline_tid: "tid-attempt",
					function_id: "fn-attempt",
				},
			],
			ts: 4,
		})
		const attemptResult: ClineUserToolResultContentBlock = {
			type: "tool_result",
			content: [
				{
					type: "text",
					text: "The user provided the following feedback:\n<feedback>\nplease continue\n</feedback>",
				},
			],
			dline_tid: "tid-attempt",
			function_id: "fn-attempt",
		}
		task.taskState.userMessageContent = [attemptResult]

		const boundary = task.getOrdinaryContextCompactionBoundary()

		expect(indexLogicalTurns(boundary.sourceHistory).issues).toEqual([])
		expect(boundary.sourceHistory.length).toBe(3)
		expect(boundary.targetContinuationHistory.length).toBe(2)
		expect(JSON.stringify(boundary.targetContinuationHistory)).toContain("fn-attempt")
		expect(JSON.stringify(boundary.sourceHistory)).not.toContain("please continue")
		expect(JSON.stringify(boundary.targetContinuationHistory)).not.toContain("please continue")
	})

	it("keeps the latest conversational turn protected when pending feedback completes it", () => {
		const task = createHarness()
		task.messageStateHandler.apiConversationHistory = [
			{ role: "user", content: [{ type: "text", text: "turn A" }], ts: 1 },
			{
				role: "assistant",
				content: [{ type: "tool_use", name: "qna_respond", input: {}, dline_tid: "tid-a", function_id: "fn-a" }],
				ts: 2,
			},
			{
				role: "user",
				content: [
					{
						...pendingToolResult("<feedback>\nturn B request\n</feedback>"),
						dline_tid: "tid-a",
						function_id: "fn-a",
					},
				],
				ts: 3,
			},
			{
				role: "assistant",
				content: [{ type: "tool_use", name: "qna_respond", input: {}, dline_tid: "tid-b", function_id: "fn-b" }],
				ts: 4,
			},
			{
				role: "user",
				content: [
					{
						...pendingToolResult("<feedback>\nturn C request\n</feedback>"),
						dline_tid: "tid-b",
						function_id: "fn-b",
					},
				],
				ts: 5,
			},
			{
				role: "assistant",
				content: [{ type: "tool_use", name: "qna_respond", input: {}, dline_tid: "tid-c", function_id: "fn-c" }],
				ts: 6,
			},
		]
		const pendingResultC = {
			...pendingToolResult("<feedback>\ncontinuation request\n</feedback>"),
			dline_tid: "tid-c",
			function_id: "fn-c",
		}

		const boundary = task.getOrdinaryContextCompactionBoundary([pendingResultC])
		const sourceText = JSON.stringify(boundary.sourceHistory)
		const continuationText = JSON.stringify(boundary.targetContinuationHistory)

		expect(indexLogicalTurns(boundary.sourceHistory).issues).toEqual([])
		expect(sourceText).toContain("fn-a")
		expect(sourceText).toContain("fn-b")
		expect(sourceText).not.toContain("fn-c")
		expect(continuationText).toContain("fn-c")
		expect(continuationText).not.toContain("continuation request")
	})

	it("makes a pending-completed side-effect turn compressible without retaining its summarized history payload", () => {
		const task = createHarness()
		task.messageStateHandler.apiConversationHistory = [
			{ role: "user", content: [{ type: "text", text: "older turn" }], ts: 1 },
			{ role: "assistant", content: [{ type: "text", text: "older response" }], ts: 2 },
			{ role: "user", content: [{ type: "text", text: "latest turn" }], ts: 3 },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						name: "read_file",
						input: { path: "large.txt" },
						dline_tid: "tid-read-latest",
						function_id: "fn-read-latest",
					},
				],
				ts: 4,
			},
		]
		const pendingResult: ClineUserToolResultContentBlock = {
			type: "tool_result",
			content: [{ type: "text", text: "large file result" }],
			dline_tid: "tid-read-latest",
			function_id: "fn-read-latest",
		}

		const boundary = task.getOrdinaryContextCompactionBoundary([pendingResult])
		const sourceText = JSON.stringify(boundary.sourceHistory)
		const continuationText = JSON.stringify(boundary.targetContinuationHistory)

		expect(indexLogicalTurns(boundary.sourceHistory)).toMatchObject({
			turns: [expect.any(Object), expect.any(Object)],
			protectedStartMessageIndex: boundary.sourceHistory.length,
			issues: [],
		})
		expect(sourceText).toContain("latest turn")
		expect(sourceText).toContain("fn-read-latest")
		expect(sourceText).toContain("large file result")
		expect(continuationText).not.toContain("latest turn")
		expect(continuationText).not.toContain("fn-read-latest")
		expect(continuationText).not.toContain("large file result")
	})

	it("pairs pending results for multiple different tools without retaining the completed turn", () => {
		const task = createHarness()
		// Canonical history: user → assistant with TWO tool uses (qna + read_file).
		task.messageStateHandler.apiConversationHistory[1] = {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					name: "qna_respond",
					input: { response: "question" },
					dline_tid: "tid-qna",
					function_id: "fn-qna",
				},
				{
					type: "tool_use",
					name: "read_file",
					input: { path: "a.txt" },
					dline_tid: "tid-read",
					function_id: "fn-read",
				},
			],
			ts: 2,
		}
		const readResult: ClineUserToolResultContentBlock = {
			type: "tool_result",
			content: [{ type: "text", text: "file contents" }],
			dline_tid: "tid-read",
			function_id: "fn-read",
		}
		task.taskState.userMessageContent = [pendingToolResult("plain qna result"), readResult]

		const boundary = task.getOrdinaryContextCompactionBoundary()

		expect(boundary.targetContinuationHistory).toEqual([])
		expect(boundary.sourceHistory.length).toBe(3)
		const lastSourceMessage = boundary.sourceHistory[boundary.sourceHistory.length - 1]
		const results = (lastSourceMessage?.content as ClineContent[]).filter(
			(block): block is ClineUserToolResultContentBlock => block.type === "tool_result",
		)
		expect(results.map((result) => result.function_id)).toEqual(["fn-qna", "fn-read"])
	})

	it("excludes transient tool_feedback blocks from the pairing view", () => {
		const task = createHarness()
		const transientFeedback = {
			type: "tool_feedback",
			content: { type: "text", text: "transient" },
		}
		task.taskState.userMessageContent = [transientFeedback as unknown as ClineContent]

		const boundary = task.getOrdinaryContextCompactionBoundary()

		// Without a pairing tool_result the pending qna tool_use keeps the whole
		// turn protected, and tool_feedback must not leak into the boundary view.
		expect(boundary.sourceHistory).toEqual([])
		expect(boundary.targetContinuationHistory.length).toBe(2)
		expect(boundary.targetContinuationHistory[0]?.role).toBe("user")
		expect(boundary.targetContinuationHistory[1]?.role).toBe("assistant")
	})

	it("treats pending tagged text as the start of the next round instead of pairing it", () => {
		const task = createHarness()
		// qna turn is canonically complete: user → assistant tool_use → user result.
		task.messageStateHandler.apiConversationHistory.push({
			role: "user",
			content: [pendingToolResult()],
			ts: 3,
		})
		const pendingText = { type: "text", text: "<feedback>\nnew user instruction\n</feedback>" }
		task.taskState.userMessageContent = [pendingText as unknown as ClineContent]

		const boundary = task.getOrdinaryContextCompactionBoundary()

		// The canonical qna turn is fully summarizable source; the pending text is
		// the upcoming round's own content and must not appear in the tail.
		expect(boundary.sourceHistory.length).toBe(3)
		expect(boundary.targetContinuationHistory).toEqual([])
	})

	it.each([
		"qna_respond",
		"attempt_completion",
		"make_plan",
		"generate_report",
		"new_task",
	])("projects an awaiting %s presentation as a pairing-safe task-header source", (toolName) => {
		const task = createHarness(toolName)
		const canonicalBefore = structuredClone(task.messageStateHandler.apiConversationHistory)

		const boundary = task.getTaskHeaderContextCompactionBoundary()

		expect(indexLogicalTurns(boundary.sourceHistory)).toMatchObject({
			turns: [{ startMessageIndex: 0, endMessageIndex: 2 }],
			protectedStartMessageIndex: boundary.sourceHistory.length,
			issues: [],
		})
		expect(boundary.targetContinuationHistory).toEqual([canonicalBefore[1]])
		expect(boundary.targetContinuationHistory[0]?.role).toBe("assistant")
		expect(JSON.stringify(boundary.targetContinuationHistory)).toContain("fn-qna")
		expect(task.messageStateHandler.apiConversationHistory).toEqual(canonicalBefore)
	})

	it("does not synthesize task-header completion for an unpaired side-effect tool", () => {
		const task = createHarness("read_file")
		const canonicalBefore = structuredClone(task.messageStateHandler.apiConversationHistory)

		const boundary = task.getTaskHeaderContextCompactionBoundary()

		expect(boundary.sourceHistory).toEqual([])
		expect(boundary.targetContinuationHistory).toEqual(canonicalBefore)
		expect(task.messageStateHandler.apiConversationHistory).toEqual(canonicalBefore)
	})
})
