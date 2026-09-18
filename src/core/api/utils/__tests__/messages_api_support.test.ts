import { ServerTool } from "@shared/proto/dline/models/metadata"
import { expect } from "chai"
import type { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
import { describe, it } from "vitest"
import { OutputLimitExceededError } from "../../stream/OutputLimitExceededError"
import {
	convertOpenAIToolsToAnthropicTools,
	handleAnthropicMessagesApiStreamResponse,
	mergeAnthropicServerTools,
} from "../messages_api_support"

const createAsyncIterable = (events: any[]) =>
	({
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield event
			}
		},
	}) as any

async function collectChunks(events: any[]) {
	const chunks: any[] = []
	for await (const chunk of handleAnthropicMessagesApiStreamResponse(createAsyncIterable(events))) {
		chunks.push(chunk)
	}
	return chunks
}

describe("messages_api_support", () => {
	describe("convertOpenAIToolsToAnthropicTools", () => {
		it("returns undefined when tools are missing", () => {
			expect(convertOpenAIToolsToAnthropicTools(undefined)).to.equal(undefined)
			expect(convertOpenAIToolsToAnthropicTools([])).to.equal(undefined)
		})

		it("converts function tools and defaults schema type to object", () => {
			const tools: OpenAITool[] = [
				{
					type: "function",
					function: {
						name: "read_file",
						description: "Read a file from disk",
						parameters: {
							properties: {
								path: { type: "string" },
							},
							required: ["path"],
						},
					},
				},
			]

			const converted = convertOpenAIToolsToAnthropicTools(tools)

			expect(converted).to.deep.equal([
				{
					name: "read_file",
					description: "Read a file from disk",
					input_schema: {
						type: "object",
						properties: {
							path: { type: "string" },
						},
						required: ["path"],
					},
				},
			])
		})

		it("filters out invalid tools", () => {
			const tools = [
				{
					type: "other",
					function: {
						name: "ignored",
					},
				},
				{
					type: "function",
					function: {
						name: "",
					},
				},
				{
					type: "function",
					function: {
						name: "valid_tool",
						parameters: { type: "object", properties: {} },
					},
				},
			] as any as OpenAITool[]

			const converted = convertOpenAIToolsToAnthropicTools(tools)

			expect(converted).to.have.length(1)
			expect(converted?.[0]).to.deep.include({ name: "valid_tool" })
		})

		it("replaces a local web_search function with one hosted Anthropic declaration", () => {
			const converted = convertOpenAIToolsToAnthropicTools(
				[
					{
						type: "function",
						function: { name: "web_search", description: "Local search", parameters: { type: "object" } },
					},
					{
						type: "function",
						function: { name: "read_file", description: "Read", parameters: { type: "object" } },
					},
				],
				[ServerTool.WEB_SEARCH],
			)

			expect(converted).to.deep.equal([
				{ name: "read_file", description: "Read", input_schema: { type: "object" } },
				{ type: "web_search_20260318", name: "web_search", allowed_callers: ["direct"] },
			])
		})

		it("keeps an Anthropic local web_search tool unless hosted search was selected", () => {
			const localTool = {
				name: "web_search",
				description: "Local search",
				input_schema: { type: "object" as const, properties: {} },
			}

			expect(mergeAnthropicServerTools([localTool])).to.deep.equal([localTool])
		})

		it("declares hosted web search on its own, depending on no other server tool", () => {
			// The provider runs this search itself. Pairing it with a sandbox would
			// subject every search to the sandbox's own per-turn execution budget.
			expect(mergeAnthropicServerTools(undefined, [ServerTool.WEB_SEARCH])).to.deep.equal([
				{ type: "web_search_20260318", name: "web_search", allowed_callers: ["direct"] },
			])
		})

		it("declares the sandbox beside web search without linking them", () => {
			// Absence of allowed_callers is the contract under test: it keeps searches
			// out of the sandbox and off its per-turn execution budget.
			expect(mergeAnthropicServerTools(undefined, [ServerTool.WEB_SEARCH, ServerTool.CODE_EXECUTION])).to.deep.equal([
				{ type: "web_search_20260318", name: "web_search", allowed_callers: ["direct"] },
				{ type: "code_execution_20260120", name: "code_execution", allowed_callers: ["direct"] },
			])
		})

		it("declares the sandbox alone when hosted search was not selected", () => {
			expect(mergeAnthropicServerTools(undefined, [ServerTool.CODE_EXECUTION])).to.deep.equal([
				{ type: "code_execution_20260120", name: "code_execution", allowed_callers: ["direct"] },
			])
		})
	})

	describe("handleAnthropicMessagesApiStreamResponse", () => {
		it("maps usage, reasoning, and text events into ApiStream chunks", async () => {
			const chunks = await collectChunks([
				{
					type: "message_start",
					message: {
						usage: {
							input_tokens: 10,
							output_tokens: 2,
							cache_creation_input_tokens: 4,
							cache_read_input_tokens: 3,
						},
					},
				},
				{
					type: "content_block_start",
					content_block: {
						type: "thinking",
						thinking: "first thought",
						signature: "sig-start",
					},
					index: 0,
				},
				{
					type: "content_block_delta",
					delta: {
						type: "thinking_delta",
						thinking: " then more",
					},
				},
				{
					type: "content_block_delta",
					delta: {
						type: "signature_delta",
						signature: "sig-final",
					},
				},
				{
					type: "content_block_start",
					content_block: {
						type: "text",
						text: "Hello",
					},
					index: 0,
				},
				{
					type: "content_block_start",
					content_block: {
						type: "text",
						text: "World",
					},
					index: 1,
				},
				{
					type: "message_delta",
					usage: {
						output_tokens: 9,
					},
				},
			])

			expect(chunks).to.deep.equal([
				{
					type: "usage",
					inputTokens: 10,
					outputTokens: 2,
					cacheWriteTokens: 4,
					cacheReadTokens: 3,
				},
				{
					type: "reasoning",
					reasoning: "first thought",
					signature: "sig-start",
				},
				{
					type: "reasoning",
					reasoning: " then more",
				},
				{
					type: "reasoning",
					reasoning: "",
					signature: "sig-final",
				},
				{
					type: "text",
					text: "Hello",
				},
				{
					type: "text",
					text: "\n",
				},
				{
					type: "text",
					text: "World",
				},
				{
					type: "usage",
					inputTokens: 0,
					outputTokens: 9,
				},
			])
		})

		it("emits tool call chunks and resets tool state on block stop", async () => {
			const chunks = await collectChunks([
				{
					type: "content_block_start",
					content_block: {
						type: "tool_use",
						id: "tool_1",
						name: "read_file",
					},
					index: 0,
				},
				{
					type: "content_block_delta",
					delta: {
						type: "input_json_delta",
						partial_json: '{"path":',
					},
				},
				{
					type: "content_block_stop",
				},
				{
					type: "content_block_delta",
					delta: {
						type: "input_json_delta",
						partial_json: '"ignored-after-stop"}',
					},
				},
			])

			expect(chunks).to.have.length(1)
			expect(chunks[0]).to.deep.equal({
				type: "tool_calls",
				function_id: "tool_1",
				tool_call: {
					function: {
						name: "read_file",
						arguments: '{"path":',
					},
				},
			})
		})

		it("emits hosted web search lifecycle and usage without local tool_calls", async () => {
			const result = [
				{
					type: "web_search_result",
					url: "https://example.com/result",
					title: "Result",
					page_age: null,
					encrypted_content: "encrypted",
				},
			]
			const chunks = await collectChunks([
				{
					type: "message_start",
					message: {
						usage: {
							input_tokens: 10,
							output_tokens: 0,
							server_tool_use: { web_search_requests: 1, web_fetch_requests: 0 },
						},
					},
				},
				{
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "server_tool_use",
						id: "srv_web_1",
						name: "web_search",
						input: {},
						caller: { type: "direct" },
					},
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: {
						type: "input_json_delta",
						partial_json: '{"query":"Dline"}',
					},
				},
				{
					type: "content_block_stop",
					index: 0,
				},
				{
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "web_search_tool_result",
						tool_use_id: "srv_web_1",
						content: result,
						caller: { type: "direct" },
					},
				},
			])

			expect(chunks).to.deep.equal([
				{
					type: "usage",
					inputTokens: 10,
					outputTokens: 0,
					cacheWriteTokens: undefined,
					cacheReadTokens: undefined,
					serverToolUsage: { webSearchRequests: 1 },
				},
				{
					type: "server_tool",
					function_id: "srv_web_1",
					tool: ServerTool.WEB_SEARCH,
					phase: "started",
					input: {},
				},
				{
					type: "server_tool",
					function_id: "srv_web_1",
					tool: ServerTool.WEB_SEARCH,
					phase: "searching",
					input: { query: "Dline" },
				},
				{
					type: "server_tool",
					function_id: "srv_web_1",
					tool: ServerTool.WEB_SEARCH,
					phase: "completed",
					result,
				},
			])
			expect(chunks.some((chunk) => chunk.type === "tool_calls")).to.equal(false)
		})

		it("maps Anthropic hosted web search errors to a failed server_tool event", async () => {
			const error = { type: "web_search_tool_result_error", error_code: "too_many_requests" }
			const chunks = await collectChunks([
				{
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "server_tool_use",
						id: "srv_web_error",
						name: "web_search",
						input: {},
						caller: { type: "direct" },
					},
				},
				{
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "web_search_tool_result",
						tool_use_id: "srv_web_error",
						content: error,
						caller: { type: "direct" },
					},
				},
			])

			expect(chunks).to.deep.equal([
				{
					type: "server_tool",
					function_id: "srv_web_error",
					tool: ServerTool.WEB_SEARCH,
					phase: "started",
					input: {},
				},
				{
					type: "server_tool",
					function_id: "srv_web_error",
					tool: ServerTool.WEB_SEARCH,
					phase: "failed",
					error,
				},
			])
		})

		it("ignores an orphan Anthropic hosted web search result", async () => {
			const chunks = await collectChunks([
				{
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "web_search_tool_result",
						tool_use_id: "srv_web_orphan",
						content: [],
						caller: { type: "direct" },
					},
				},
			])

			expect(chunks).to.deep.equal([])
		})

		it("emits a hosted code execution lifecycle from its own result block", async () => {
			const result = {
				type: "code_execution_result",
				stdout: "filtered",
				stderr: "",
				return_code: 0,
				content: [],
			}
			const chunks = await collectChunks([
				{
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "server_tool_use",
						id: "srv_exec_1",
						name: "code_execution",
						input: {},
						caller: { type: "direct" },
					},
				},
				{
					type: "content_block_delta",
					index: 0,
					delta: { type: "input_json_delta", partial_json: '{"code":"print(1)"}' },
				},
				{ type: "content_block_stop", index: 0 },
				{
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "code_execution_tool_result",
						tool_use_id: "srv_exec_1",
						content: result,
					},
				},
			])

			expect(chunks).to.deep.equal([
				{
					type: "server_tool",
					function_id: "srv_exec_1",
					tool: ServerTool.CODE_EXECUTION,
					phase: "started",
					input: {},
				},
				{
					type: "server_tool",
					function_id: "srv_exec_1",
					tool: ServerTool.CODE_EXECUTION,
					phase: "in_progress",
					input: { code: "print(1)" },
				},
				{
					type: "server_tool",
					function_id: "srv_exec_1",
					tool: ServerTool.CODE_EXECUTION,
					phase: "completed",
					result,
				},
			])
		})

		it.each([
			["bash_code_execution", "bash_code_execution_tool_result"],
			["text_editor_code_execution", "text_editor_code_execution_tool_result"],
		])("completes a %s call from its own result block", async (toolName, resultType) => {
			// Each sandbox surface closes with its own result block type. Missing one
			// strands the call until the response ends and reports a false failure.
			const chunks = await collectChunks([
				{
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "server_tool_use",
						id: "srv_exec_surface",
						name: toolName,
						input: {},
						caller: { type: "direct" },
					},
				},
				{
					type: "content_block_start",
					index: 1,
					content_block: {
						type: resultType,
						tool_use_id: "srv_exec_surface",
						content: { type: "code_execution_result", stdout: "ok", stderr: "", return_code: 0, content: [] },
					},
				},
			])

			expect(chunks.map((chunk) => chunk.phase)).to.deep.equal(["started", "completed"])
			expect(chunks.every((chunk) => chunk.tool === ServerTool.CODE_EXECUTION)).to.equal(true)
		})

		it("maps a hosted code execution error to a failed server_tool event", async () => {
			const error = { type: "code_execution_tool_result_error", error_code: "execution_time_exceeded" }
			const chunks = await collectChunks([
				{
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "server_tool_use",
						id: "srv_exec_error",
						name: "code_execution",
						input: {},
						caller: { type: "direct" },
					},
				},
				{
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "code_execution_tool_result",
						tool_use_id: "srv_exec_error",
						content: error,
					},
				},
			])

			expect(chunks).to.deep.equal([
				{
					type: "server_tool",
					function_id: "srv_exec_error",
					tool: ServerTool.CODE_EXECUTION,
					phase: "started",
					input: {},
				},
				{
					type: "server_tool",
					function_id: "srv_exec_error",
					tool: ServerTool.CODE_EXECUTION,
					phase: "failed",
					error,
				},
			])
		})

		it("does not open a lifecycle for a search the sandbox issued, whose result block is excluded", async () => {
			const chunks = await collectChunks([
				{
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "server_tool_use",
						id: "srv_exec_parent",
						name: "code_execution",
						input: {},
						caller: { type: "direct" },
					},
				},
				{
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "server_tool_use",
						id: "srv_web_nested",
						name: "web_search",
						input: { query: "Dline" },
						caller: { type: "code_execution_20260120", tool_id: "srv_exec_parent" },
					},
				},
				{
					type: "content_block_start",
					index: 2,
					content_block: {
						type: "code_execution_tool_result",
						tool_use_id: "srv_exec_parent",
						content: {
							type: "code_execution_result",
							stdout: "filtered",
							stderr: "",
							return_code: 0,
							content: [],
						},
					},
				},
			])

			// The nested search never reports a result block of its own, so opening a
			// lifecycle for it would leave the UI showing work that never completes.
			expect(chunks.some((chunk) => chunk.function_id === "srv_web_nested")).to.equal(false)
			expect(chunks.map((chunk) => chunk.phase)).to.deep.equal(["started", "completed"])
			expect(chunks.every((chunk) => chunk.tool === ServerTool.CODE_EXECUTION)).to.equal(true)
		})

		it("throws a typed output-limit error when Anthropic stops at max_tokens", async () => {
			let caught: unknown
			try {
				await collectChunks([
					{
						type: "message_delta",
						delta: { stop_reason: "max_tokens", stop_sequence: null },
						usage: { output_tokens: 30_000 },
					},
					{ type: "message_stop" },
				])
			} catch (error) {
				caught = error
			}

			expect(caught).to.be.instanceOf(OutputLimitExceededError)
			expect(caught).to.deep.include({
				code: "output_limit_exceeded",
				protocol: "anthropic_messages",
				reason: "max_tokens",
			})
		})
	})
})
