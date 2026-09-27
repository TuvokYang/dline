import { ClineMessage } from "@shared/ExtensionMessage"
import type { ClineContent, ClineStorageMessage, ClineTextContentBlock } from "@shared/messages/content"
import { expect } from "chai"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { vi } from "vitest"
import { ContextManager } from "../ContextManager"

// Minimal mock for ApiHandler — only getModel().info.capabilities.contextWindow is used by shouldCompactContextWindow
function createMockApi(contextWindow: number) {
	return {
		getModel: () => ({ id: "test-model", info: { capabilities: { contextWindow } } }),
	} as any
}

function createApiReqMessage(tokens: {
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	estimatedContextTokens?: number
}): ClineMessage {
	return {
		ts: Date.now(),
		type: "say",
		say: "api_req_started",
		text: JSON.stringify(tokens),
	}
}

describe("ContextManager", () => {
	function createMessages(count: number): ClineStorageMessage[] {
		const messages: ClineStorageMessage[] = []

		messages.push({
			role: "user",
			content: "Initial task message",
		})

		let role: "user" | "assistant" = "assistant"
		for (let i = 1; i < count; i++) {
			messages.push({
				role,
				content: `Message ${i}`,
			})
			role = role === "user" ? "assistant" : "user"
		}

		return messages
	}

	describe("context history persistence", () => {
		it("replays append-only truncate markers without rewriting the snapshot", async () => {
			const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-context-history-marker-"))
			const filePath = path.join(taskDirectory, "context_history.jsonl")
			const snapshot = [
				[
					1,
					[
						0,
						[
							[
								0,
								[
									[100, "text", ["old"], []],
									[200, "text", ["new"], []],
								],
							],
						],
					],
				],
			]
			await fs.writeFile(filePath, `${JSON.stringify(snapshot)}\n`, "utf8")
			const messages: ClineStorageMessage[] = [
				{ role: "user", content: [{ type: "text", text: "task" }] },
				{ role: "assistant", content: [{ type: "text", text: "original" }] },
			]
			const manager = new ContextManager()
			await manager.initializeContextHistory(taskDirectory)
			expect((manager.applyContextHistoryUpdatesToCanonical(messages)[1].content as ClineContent[])[0]).to.deep.equal({
				type: "text",
				text: "new",
			})

			const writeSpy = vi.spyOn(fs, "writeFile")
			try {
				await manager.truncateContextHistory(150, taskDirectory)
				expect(writeSpy.mock.calls).to.have.length(0)
			} finally {
				writeSpy.mockRestore()
			}
			expect((manager.applyContextHistoryUpdatesToCanonical(messages)[1].content as ClineContent[])[0]).to.deep.equal({
				type: "text",
				text: "old",
			})

			const reopened = new ContextManager()
			await reopened.initializeContextHistory(taskDirectory)
			expect((reopened.applyContextHistoryUpdatesToCanonical(messages)[1].content as ClineContent[])[0]).to.deep.equal({
				type: "text",
				text: "old",
			})
			await fs.rm(taskDirectory, { recursive: true, force: true })
		})
	})

	describe("getNextTruncationRange", () => {
		let contextManager: ContextManager

		beforeEach(() => {
			contextManager = new ContextManager()
		})

		it("first truncation with half keep", () => {
			const messages = createMessages(11)
			const result = contextManager.getNextTruncationRange(messages, undefined, "half")

			expect(result).to.deep.equal([2, 5])
		})

		it("first truncation with quarter keep", () => {
			const messages = createMessages(11)
			const result = contextManager.getNextTruncationRange(messages, undefined, "quarter")

			expect(result).to.deep.equal([2, 7])
		})

		it("sequential truncation with half keep", () => {
			const messages = createMessages(21)
			const firstRange = contextManager.getNextTruncationRange(messages, undefined, "half")
			expect(firstRange).to.deep.equal([2, 9])

			// Pass the previous range for sequential truncation
			const secondRange = contextManager.getNextTruncationRange(messages, firstRange, "half")
			expect(secondRange).to.deep.equal([2, 13])
		})

		it("sequential truncation with quarter keep", () => {
			const messages = createMessages(41)
			const firstRange = contextManager.getNextTruncationRange(messages, undefined, "quarter")

			const secondRange = contextManager.getNextTruncationRange(messages, firstRange, "quarter")

			expect(secondRange[0]).to.equal(2)
			expect(secondRange[1]).to.be.greaterThan(firstRange[1])
		})

		it("ensures the last message in range is a user message", () => {
			const messages = createMessages(14)
			const result = contextManager.getNextTruncationRange(messages, undefined, "half")

			// Check if the message at the end of range is an assistant message
			const lastRemovedMessage = messages[result[1]]
			expect(lastRemovedMessage.role).to.equal("assistant")

			// Check if the next message after the range is a user message
			const nextMessage = messages[result[1] + 1]
			expect(nextMessage.role).to.equal("user")
		})

		it("handles small message arrays", () => {
			const messages = createMessages(3)
			const result = contextManager.getNextTruncationRange(messages, undefined, "half")

			expect(result).to.deep.equal([2, 1])
		})

		it("drops completed middle turns while retaining the latest unpaired user turn", () => {
			const messages = createMessages(7)
			const result = contextManager.getNextTruncationRange(messages, undefined, "none")
			const effectiveMessages = [...messages.slice(0, result[0]), ...messages.slice(result[1] + 1)]

			expect(result).to.deep.equal([2, 5])
			expect(effectiveMessages).to.deep.equal([messages[0], messages[1], messages[6]])
		})

		it("preserves the message structure when truncating", () => {
			const messages = createMessages(20)
			const result = contextManager.getNextTruncationRange(messages, undefined, "half")

			// Get messages after removing the range
			const effectiveMessages = [...messages.slice(0, result[0]), ...messages.slice(result[1] + 1)]

			// Check first message and alternating pattern
			expect(effectiveMessages[0].role).to.equal("user")
			for (let i = 1; i < effectiveMessages.length; i++) {
				const expectedRole = i % 2 === 1 ? "assistant" : "user"
				expect(effectiveMessages[i].role).to.equal(expectedRole)
			}
		})

		it("retains the original task while dropping injected first-request metadata", async () => {
			const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-context-task-"))
			const messages: ClineStorageMessage[] = [
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "<task>\nKeep this task\n</task>\n\n# task_progress RECOMMENDED\n<environment_details>large metadata</environment_details>",
						},
					],
				},
				{ role: "assistant", content: [{ type: "text", text: "Initial response" }] },
				{ role: "user", content: [{ type: "text", text: "Middle turn" }] },
				{ role: "assistant", content: [{ type: "text", text: "Middle response" }] },
				{ role: "user", content: [{ type: "text", text: "Latest turn" }] },
			]

			try {
				await contextManager.triggerApplyStandardContextTruncationNoticeChange(Date.now(), taskDirectory, messages)
				const truncated = contextManager.getTruncatedMessages(messages, [2, 3])
				const firstBlock = (truncated[0].content as ClineTextContentBlock[])[0]

				expect(firstBlock.text).to.equal("<task>\nKeep this task\n</task>")
				expect(firstBlock.text).not.to.contain("task_progress")
				expect(firstBlock.text).not.to.contain("environment_details")
				expect((truncated[2].content as ClineTextContentBlock[])[0].text).to.equal("Latest turn")
			} finally {
				await fs.rm(taskDirectory, { recursive: true, force: true })
			}
		})

		it("inserts the truncation notice before a native tool-only first response", async () => {
			const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-context-native-tool-"))
			const messages: ClineStorageMessage[] = [
				{ role: "user", content: [{ type: "text", text: "<task>Keep this task</task>" }] },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							function_id: "call_initial_qna",
							dline_tid: "dline_tid_initial_qna",
							name: "qna_respond",
							input: { response: "Initial question" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							function_id: "call_initial_qna",
							dline_tid: "dline_tid_initial_qna",
							content: "Middle feedback",
						},
					],
				},
				{ role: "assistant", content: [{ type: "text", text: "Middle response" }] },
				{ role: "user", content: [{ type: "text", text: "Latest turn" }] },
			]

			try {
				await contextManager.triggerApplyStandardContextTruncationNoticeChange(Date.now(), taskDirectory, messages)
				const truncated = contextManager.getTruncatedMessages(messages, [2, 3])
				const assistantContent = truncated[1].content as ClineContent[]

				expect(assistantContent[0]).to.deep.include({
					type: "text",
					text: "[NOTE] Some previous conversation history with the user has been removed to maintain optimal context window length. The initial user task has been retained for continuity, while intermediate conversation history has been removed. Keep this in mind as you continue assisting the user. Pay special attention to the user's latest messages.",
				})
				expect(assistantContent[1]).to.deep.include({
					type: "tool_use",
					function_id: "call_initial_qna",
					dline_tid: "dline_tid_initial_qna",
				})
				const retainedUserContent = truncated[2].content as ClineContent[]
				expect(retainedUserContent.some((block) => block.type === "tool_result")).to.equal(true)
				expect(JSON.stringify(retainedUserContent)).to.contain("Latest turn")
			} finally {
				await fs.rm(taskDirectory, { recursive: true, force: true })
			}
		})
	})

	describe("applyContextOptimizations", () => {
		let contextManager: ContextManager

		beforeEach(() => {
			contextManager = new ContextManager()
		})

		it("detects duplicate file reads across write_to_file, replace_in_file, and file mentions (normal tool calling)", () => {
			const messages: ClineStorageMessage[] = [
				{ role: "user", content: "Initial task" },
				{ role: "assistant", content: "Response" },
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "[write_to_file for 'test.txt'] Result:\nThe content was successfully saved to test.txt.\n\nHere is the full, updated content of the file that was saved:\n\n<final_file_content path=\"test.txt\">\ntest\n\n</final_file_content>",
						},
						{
							type: "text",
							text: "<environment_details>\n# Visual Studio Code Visible Files\ntest.txt\n\n# Current Mode\nACT MODE\n</environment_details>",
						},
					],
				},
				{ role: "assistant", content: "Response" },
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "[replace_in_file for 'test.txt'] Result:\nThe content was successfully saved to test.txt.\n\nHere is the full, updated content of the file that was saved:\n\n<final_file_content path=\"test.txt\">\ntest 2\n\n</final_file_content>",
						},
						{
							type: "text",
							text: "<environment_details>\n# Visual Studio Code Visible Files\ntest.txt\n\n# Current Mode\nACT MODE\n</environment_details>",
						},
					],
				},
				{ role: "assistant", content: "Response" },
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "[TASK RESUMPTION] This task was interrupted just now. The conversation may have been incomplete.",
						},
						{
							type: "text",
							text: "New message to respond to:\n<user_message>\n'test.txt' (see below for file content) tell me whats in this file\n</user_message>\n\n<file_content path=\"test.txt\">\ntest 2\n\n</file_content>",
						},
					],
				},
			]

			const timestamp = Date.now()
			const [didUpdate, indices] = contextManager.applyContextOptimizations(messages, 2, timestamp)

			expect(didUpdate).to.equal(true)
			expect(indices.size).to.equal(2)
			expect(indices.has(2)).to.equal(true)
			expect(indices.has(4)).to.equal(true)
			expect(indices.has(6)).to.equal(false)
		})

		it("returns false when no duplicate file reads exist", () => {
			const messages: ClineStorageMessage[] = [
				{ role: "user", content: "Initial task" },
				{ role: "assistant", content: "Response" },
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "[write_to_file for 'test.txt'] Result:\n<final_file_content path=\"test.txt\">\ntest\n\n</final_file_content>",
						},
					],
				},
				{ role: "assistant", content: "Response" },
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "[write_to_file for 'other.txt'] Result:\n<final_file_content path=\"other.txt\">\nother content\n\n</final_file_content>",
						},
					],
				},
			]

			const [didUpdate, indices] = contextManager.applyContextOptimizations(messages, 2, Date.now())

			expect(didUpdate).to.equal(false)
			expect(indices.size).to.equal(0)
		})

		it("returns false for empty messages beyond startFromIndex", () => {
			const messages: ClineStorageMessage[] = [
				{ role: "user", content: "Initial task" },
				{ role: "assistant", content: "Response" },
			]

			const [didUpdate, indices] = contextManager.applyContextOptimizations(messages, 2, Date.now())

			expect(didUpdate).to.equal(false)
			expect(indices.size).to.equal(0)
		})

		it("detects duplicate file reads with native tool calling format (tool_result blocks)", () => {
			const messages: ClineStorageMessage[] = [
				{ role: "user", content: "Initial task" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							function_id: "toolu_001",
							dline_tid: "tid_001",
							name: "make_plan",
							input: {},
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							function_id: "toolu_001",
							dline_tid: "tid_001",
							content: [
								{
									type: "text",
									text: "[make_plan] Result:\n<user_message>\n'test2.txt' (see below for file content)\n</user_message>\n\n<file_content path=\"/Users/toshi/Desktop/cline_testing_repo/test2.txt\">\ntest\n\n</file_content>",
								},
							],
						},
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							function_id: "toolu_002",
							dline_tid: "tid_002",
							name: "write_to_file",
							input: {},
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							function_id: "toolu_002",
							dline_tid: "tid_002",
							content: [
								{
									type: "text",
									text: "[write_to_file for '/Users/toshi/Desktop/cline_testing_repo/test2.txt'] Result:\nThe content was successfully saved.\n\n<final_file_content path=\"/Users/toshi/Desktop/cline_testing_repo/test2.txt\">\ntest\n\n</final_file_content>",
								},
							],
						},
						{ type: "text", text: "<environment_details>\n# Current Mode\nACT MODE\n</environment_details>" },
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							function_id: "toolu_003",
							dline_tid: "tid_003",
							name: "text",
							input: {},
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "[TASK RESUMPTION] This task was interrupted just now. The conversation may have been incomplete.",
						},
						{ type: "text", text: "New message to respond to with make_plan tool" },
					],
				},
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							function_id: "toolu_004",
							dline_tid: "tid_004",
							name: "replace_in_file",
							input: {},
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							function_id: "toolu_004",
							dline_tid: "tid_004",
							content: [
								{
									type: "text",
									text: "[replace_in_file for '/Users/toshi/Desktop/cline_testing_repo/test2.txt'] Result:\nThe content was successfully saved.\n\n<final_file_content path=\"/Users/toshi/Desktop/cline_testing_repo/test2.txt\">\ntest2\n\n</final_file_content>",
								},
							],
						},
						{ type: "text", text: "<environment_details>\n# Current Mode\nACT MODE\n</environment_details>" },
					],
				},
			]

			const timestamp = Date.now()
			const [didUpdate, indices] = contextManager.applyContextOptimizations(messages, 2, timestamp)

			expect(didUpdate).to.equal(true)
			expect(indices.size).to.equal(2)
			expect(indices.has(2)).to.equal(true)
			expect(indices.has(4)).to.equal(true)
			expect(indices.has(8)).to.equal(false)
		})
	})

	describe("getTruncatedMessages", () => {
		let contextManager: ContextManager

		beforeEach(() => {
			contextManager = new ContextManager()
		})

		it("returns original messages when no range is provided", () => {
			const messages = createMessages(3)

			const result = contextManager.getTruncatedMessages(messages, undefined)
			expect(result).to.deep.equal(messages)
		})

		it("correctly removes messages in the specified range", () => {
			const messages = createMessages(5)

			const range: [number, number] = [1, 3]
			const result = contextManager.getTruncatedMessages(messages, range)

			expect(result).to.have.lengthOf(3)
			expect(result[0]).to.deep.equal(messages[0])
			expect(result[1]).to.deep.equal(messages[1])
			expect(result[2]).to.deep.equal(messages[4])
		})

		it("works with a range that starts at the first message after task", () => {
			const messages = createMessages(4)

			const range: [number, number] = [1, 2]
			const result = contextManager.getTruncatedMessages(messages, range)

			expect(result).to.have.lengthOf(3)
			expect(result[0]).to.deep.equal(messages[0])
			expect(result[1]).to.deep.equal(messages[1])
			expect(result[2]).to.deep.equal(messages[3])
		})

		it("correctly handles removing a range while preserving alternation pattern", () => {
			const messages = createMessages(5)

			const range: [number, number] = [2, 3]
			const result = contextManager.getTruncatedMessages(messages, range)

			expect(result).to.have.lengthOf(3)
			expect(result[0]).to.deep.equal(messages[0])
			expect(result[1]).to.deep.equal(messages[1])
			expect(result[2]).to.deep.equal(messages[4])

			expect(result[0].role).to.equal("user")
			expect(result[1].role).to.equal("assistant")
			expect(result[2].role).to.equal("user")
		})

		it("preserves a canonical result paired by function_id when item_id differs", () => {
			const messages = [
				{ role: "user", content: "Initial task" },
				{ role: "assistant", content: "Response 1" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							function_id: "call_provider_1",
							dline_tid: "dline_tid_1",
							provider_metadata: { item_id: "resp_item_1" },
							name: "write_to_file",
							input: { path: "test.txt" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							function_id: "call_provider_1",
							dline_tid: "dline_tid_1",
							content: [
								{ type: "text", text: "File written." },
								{ type: "text", text: "Approval feedback." },
							],
						},
					],
				},
			] as ClineStorageMessage[]

			const result = contextManager.getTruncatedMessages(messages, undefined)
			const userContent = result[3].content as unknown as Array<Record<string, unknown>>

			expect(userContent).to.have.lengthOf(1)
			expect(userContent[0].function_id).to.equal("call_provider_1")
			expect(userContent[0]).not.to.have.property("tool_use_id")
			expect(userContent[0]).not.to.have.property("item_id")
			expect(userContent[0].content as unknown[]).to.have.lengthOf(2)
			expect(JSON.stringify(userContent)).not.to.contain("The result was not recorded")
		})

		it("removes orphaned tool_results after truncation", () => {
			// Create messages with tool_use and tool_result blocks
			const messages: ClineStorageMessage[] = [
				{ role: "user", content: "Initial task" },
				{ role: "assistant", content: "Response 1" },
				// Assistant message with tool_use that will be truncated
				{
					role: "assistant",
					content: [
						{ type: "text", text: "Using a tool" },
						{
							type: "tool_use",
							function_id: "tool_123",
							dline_tid: "tid_123",
							name: "read_file",
							input: { path: "test.ts" },
						},
					],
				},
				// User message with tool_result - should have tool_result removed after truncation
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							function_id: "tool_123",
							dline_tid: "tid_123",
							content: "file content here",
						},
						{ type: "text", text: "Additional user text" },
					],
				},
				{ role: "assistant", content: "Response 2" },
			]

			// Truncate to remove the assistant message with tool_use
			const range: [number, number] = [2, 2]
			const result = contextManager.getTruncatedMessages(messages, range)

			// Should have 4 messages (original 5 minus 1 truncated)
			expect(result).to.have.lengthOf(4)

			// The user message at index 2 should have tool_result removed but text preserved
			const userMessageAfterTruncation = result[2]
			expect(userMessageAfterTruncation.role).to.equal("user")
			expect(Array.isArray(userMessageAfterTruncation.content)).to.be.true

			const content = userMessageAfterTruncation.content as ClineContent[]
			// Should only have the text block, not the tool_result
			expect(content).to.have.lengthOf(1)
			expect(content[0].type).to.equal("text")
			expect((content[0] as ClineTextContentBlock).text).to.equal("Additional user text")
		})

		it("preserves tagged user feedback from an orphaned tool_result", () => {
			const messages: ClineStorageMessage[] = [
				{ role: "user", content: "Initial task" },
				{ role: "assistant", content: "Response 1" },
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							function_id: "qna_1",
							dline_tid: "tid_qna_1",
							name: "qna_respond",
							input: { response: "Old response that will be truncated" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							function_id: "qna_1",
							dline_tid: "tid_qna_1",
							content: [
								{
									type: "text",
									text: "[qna_respond] Result:\n<feedback>\nKeep this latest instruction\n</feedback>",
								},
							],
						},
						{ type: "text", text: "<environment_details>generated metadata</environment_details>" },
					],
				},
			]

			const result = contextManager.getTruncatedMessages(messages, [2, 2])
			const content = result[2].content as ClineContent[]

			expect(content.some((block) => block.type === "tool_result")).to.equal(false)
			expect(content[0]).to.deep.equal({ type: "text", text: "Keep this latest instruction" })
			expect(JSON.stringify(content)).not.to.contain("Old response that will be truncated")
		})
	})

	describe("shouldCompactContextWindow", () => {
		let contextManager: ContextManager

		beforeEach(() => {
			contextManager = new ContextManager()
		})

		it("does not compact below a configured 75 percent point", () => {
			const api = createMockApi(200_000)
			const clineMessages: ClineMessage[] = [createApiReqMessage({ tokensIn: 30_000, tokensOut: 3_000 })]

			const result = contextManager.shouldCompactContextWindow(clineMessages, api, 0, { triggerPercent: 75 })
			expect(result).to.equal(false)
		})

		it("compacts when a configured percentage reserve reaches the guarded trigger", () => {
			const api = createMockApi(200_000)
			const clineMessages: ClineMessage[] = [createApiReqMessage({ tokensIn: 150_000, tokensOut: 15_500 })]

			const result = contextManager.shouldCompactContextWindow(clineMessages, api, 0, { triggerPercent: 75 })
			expect(result).to.equal(true)
		})

		it("clamps a low trigger percentage to the maximum reserve", () => {
			const api = createMockApi(200_000)
			const clineMessages: ClineMessage[] = [createApiReqMessage({ tokensIn: 164_000, tokensOut: 1_500 })]

			const result = contextManager.shouldCompactContextWindow(clineMessages, api, 0, { triggerPercent: 5 })
			expect(result).to.equal(true)
		})

		it("uses the default summary-aware safety threshold when settings are omitted", () => {
			const api = createMockApi(200_000)
			const clineMessages: ClineMessage[] = [createApiReqMessage({ tokensIn: 150_000, tokensOut: 5_000 })]

			const result = contextManager.shouldCompactContextWindow(clineMessages, api, 0)
			expect(result).to.equal(false)
		})

		it("uses the configured absolute maximum context", () => {
			const api = createMockApi(200_000)
			const clineMessages: ClineMessage[] = [createApiReqMessage({ tokensIn: 150_000, tokensOut: 5_000 })]

			const result = contextManager.shouldCompactContextWindow(clineMessages, api, 0, {
				maxContextTokens: 150_000,
			})
			expect(result).to.equal(true)
		})

		it("does not compact at observed 232K pressure on 272K input context", () => {
			const api = createMockApi(272_000)
			const clineMessages: ClineMessage[] = [
				createApiReqMessage({ tokensIn: 100_000, tokensOut: 12_000, cacheWrites: 0, cacheReads: 120_000 }),
			]

			const result = contextManager.shouldCompactContextWindow(clineMessages, api, 0)
			expect(result).to.equal(false)
		})

		it("does not reserve generated summary output against input context", () => {
			const api = createMockApi(272_000)
			const clineMessages: ClineMessage[] = [
				createApiReqMessage({ tokensIn: 130_000, tokensOut: 10_000, cacheWrites: 0, cacheReads: 115_000 }),
			]

			const result = contextManager.shouldCompactContextWindow(clineMessages, api, 0)
			expect(result).to.equal(false)
		})

		it("compacts when summarize instruction overhead and safety buffer are exhausted", () => {
			const api = createMockApi(272_000)
			const clineMessages: ClineMessage[] = [
				createApiReqMessage({ tokensIn: 130_000, tokensOut: 10_000, cacheWrites: 0, cacheReads: 122_000 }),
			]

			const result = contextManager.shouldCompactContextWindow(clineMessages, api, 0)
			expect(result).to.equal(true)
		})

		it("keeps cacheWrites and cacheReads in total token count", () => {
			const api = createMockApi(200_000)
			// Low direct tokens but high cache reads push total over threshold
			const clineMessages: ClineMessage[] = [
				createApiReqMessage({ tokensIn: 5_000, tokensOut: 500, cacheWrites: 0, cacheReads: 160_000 }),
			]

			const result = contextManager.shouldCompactContextWindow(clineMessages, api, 0, { triggerPercent: 75 })
			expect(result).to.equal(true)
		})

		it("keeps reliable usage plus comparable failed-request estimate growth in the early guard", () => {
			const api = createMockApi(200_000)
			const clineMessages: ClineMessage[] = [
				createApiReqMessage({ tokensIn: 145_000, tokensOut: 5_000, estimatedContextTokens: 150_000 }),
				{
					ts: Date.now() + 1,
					type: "say",
					say: "api_req_started",
					text: JSON.stringify({
						estimatedContextTokens: 166_000,
						contextTokensSource: "estimate",
						cancelReason: "streaming_failed",
					}),
				},
			]

			const result = contextManager.shouldCompactContextWindow(clineMessages, api, 1, { triggerPercent: 75 })
			expect(result).to.equal(true)
		})

		it("returns false when previousApiReqIndex is negative", () => {
			const api = createMockApi(200_000)
			const clineMessages: ClineMessage[] = [createApiReqMessage({ tokensIn: 200_000 })]

			const result = contextManager.shouldCompactContextWindow(clineMessages, api, -1, { triggerPercent: 75 })
			expect(result).to.equal(false)
		})

		it("caps a high percentage at the summary-aware safety boundary", () => {
			const api = createMockApi(200_000)
			const clineMessages: ClineMessage[] = [createApiReqMessage({ tokensIn: 192_000 })]

			const result = contextManager.shouldCompactContextWindow(clineMessages, api, 0, { triggerPercent: 97 })
			expect(result).to.equal(true)
		})

		describe("after a completed compaction", () => {
			// Mirrors a real task: 600K window at 95% triggers at 566,500, and the last
			// pre-compaction Provider usage sat inside the shared 2K tolerance.
			const contextWindow = 600_000
			const preCompactionProviderTokens = 564_737

			function completedCompactionCard(): ClineMessage {
				return {
					ts: Date.now(),
					type: "say",
					say: "tool",
					text: JSON.stringify({ tool: "summarizeTask", compactionStatus: "completed" }),
				}
			}

			function postCompactionEstimate(estimatedContextTokens: number): ClineMessage {
				return {
					ts: Date.now() + 1,
					type: "say",
					say: "api_req_started",
					text: JSON.stringify({ estimatedContextTokens, contextTokensSource: "estimate" }),
				}
			}

			it("ignores Provider usage recorded before the compaction boundary", () => {
				const api = createMockApi(contextWindow)
				const clineMessages: ClineMessage[] = [
					createApiReqMessage({ tokensIn: preCompactionProviderTokens }),
					completedCompactionCard(),
					// The first post-compaction request failed before reporting Provider usage.
					postCompactionEstimate(51_348),
				]

				const result = contextManager.shouldCompactContextWindow(clineMessages, api, 2, { triggerPercent: 95 })
				expect(result).to.equal(false)
			})

			it("does not fall back to pre-compaction usage when no pressure follows the boundary", () => {
				const api = createMockApi(contextWindow)
				const clineMessages: ClineMessage[] = [
					createApiReqMessage({ tokensIn: preCompactionProviderTokens }),
					completedCompactionCard(),
				]

				const result = contextManager.shouldCompactContextWindow(clineMessages, api, 1, { triggerPercent: 95 })
				expect(result).to.equal(false)
			})

			it("still compacts when pressure recorded after the boundary reaches the trigger", () => {
				const api = createMockApi(contextWindow)
				const clineMessages: ClineMessage[] = [
					createApiReqMessage({ tokensIn: preCompactionProviderTokens }),
					completedCompactionCard(),
					createApiReqMessage({ tokensIn: preCompactionProviderTokens }),
				]

				const result = contextManager.shouldCompactContextWindow(clineMessages, api, 2, { triggerPercent: 95 })
				expect(result).to.equal(true)
			})
		})
	})

	describe("getNewContextMessagesAndMetadata", () => {
		let contextManager: ContextManager

		beforeEach(() => {
			contextManager = new ContextManager()
		})

		it("does not truncate standard context at observed 232K pressure on 272K input context", async () => {
			const api = createMockApi(272_000)
			const apiConversationHistory = createMessages(10)
			const clineMessages: ClineMessage[] = [
				createApiReqMessage({ tokensIn: 100_000, tokensOut: 12_000, cacheWrites: 0, cacheReads: 120_000 }),
			]
			const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-context-test-"))

			const result = await contextManager.getNewContextMessagesAndMetadata(
				apiConversationHistory,
				clineMessages,
				api,
				undefined,
				0,
				taskDirectory,
				false,
			)

			expect(result.updatedConversationHistoryDeletedRange).to.equal(false)
			expect(result.conversationHistoryDeletedRange).to.equal(undefined)
			expect(result.truncatedConversationHistory).to.deep.equal(apiConversationHistory)
		})

		it("does not advance a pairing-safe range for an internal compaction request", async () => {
			const api = createMockApi(272_000)
			const apiConversationHistory = createMessages(8)
			const clineMessages: ClineMessage[] = [createApiReqMessage({ tokensIn: 299_000, tokensOut: 1_000 })]
			const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-context-test-"))

			const result = await contextManager.getNewContextMessagesAndMetadata(
				apiConversationHistory,
				clineMessages,
				api,
				[2, 3],
				0,
				taskDirectory,
				true,
			)

			expect(result.updatedConversationHistoryDeletedRange).to.equal(false)
			expect(result.conversationHistoryDeletedRange).to.deep.equal([2, 3])
			expect(result.truncatedConversationHistory).to.deep.equal([
				...apiConversationHistory.slice(0, 2),
				...apiConversationHistory.slice(4),
			])
		})

		it("does not rewrite history when file-read optimization cannot avoid auto compact", async () => {
			const apiConversationHistory: ClineStorageMessage[] = [
				{ role: "user", content: "Initial task" },
				{ role: "assistant", content: "Initial response" },
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "Large stable context prefix. ".repeat(4_000),
						},
					],
				},
				{ role: "assistant", content: "Intermediate response" },
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "[read_file for 'src/example.ts'] Result:\nconst value = 1\n",
						},
					],
				},
				{ role: "assistant", content: "Read acknowledged" },
				{
					role: "user",
					content: [
						{
							type: "text",
							text: "[read_file for 'src/example.ts'] Result:\nconst value = 2\n",
						},
					],
				},
			]
			const clineMessages: ClineMessage[] = [createApiReqMessage({ tokensIn: 130_000, cacheReads: 132_000 })]
			const taskDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dline-context-test-"))

			const shouldCompact = await contextManager.attemptFileReadOptimization(
				apiConversationHistory,
				undefined,
				clineMessages,
				0,
				taskDirectory,
			)
			const unchangedHistory = contextManager.getTruncatedMessages(apiConversationHistory, undefined)

			expect(shouldCompact).to.equal(true)
			expect(unchangedHistory).to.deep.equal(apiConversationHistory)
		})
	})
})
