import { ServerTool } from "@shared/proto/dline/models/metadata"
import { expect } from "chai"
import { describe, it, vi } from "vitest"
import { OutputLimitExceededError } from "../../stream/OutputLimitExceededError"
import { handleResponsesApiStreamResponse } from "../responses_api_support"

const createAsyncIterable = (events: any[]) =>
	({
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield event
			}
		},
	}) as any

async function collectChunks(events: any[], calculateCost = vi.fn(async () => 0)) {
	const chunks: any[] = []
	for await (const chunk of handleResponsesApiStreamResponse(
		createAsyncIterable(events),
		{ id: "test-model" },
		calculateCost,
	)) {
		chunks.push(chunk)
	}
	return chunks
}

describe("responses_api_support hosted tools", () => {
	it("emits the complete web_search_call lifecycle without local tool_calls", async () => {
		const startedAction = { type: "search", query: "Dline" }
		const completedAction = { type: "search", query: "Dline" }
		const completedResults = [
			{
				title: "Dline result",
				url: "https://example.com/result",
				snippet: "A result returned by the hosted search provider.",
			},
		]
		const chunks = await collectChunks([
			{
				type: "response.output_item.added",
				output_index: 0,
				sequence_number: 1,
				item: { type: "web_search_call", id: "ws_1", status: "in_progress", action: startedAction },
			},
			{ type: "response.web_search_call.in_progress", item_id: "ws_1", output_index: 0, sequence_number: 2 },
			{ type: "response.web_search_call.searching", item_id: "ws_1", output_index: 0, sequence_number: 3 },
			{ type: "response.web_search_call.completed", item_id: "ws_1", output_index: 0, sequence_number: 4 },
			{
				type: "response.output_item.done",
				output_index: 0,
				sequence_number: 5,
				item: {
					type: "web_search_call",
					id: "ws_1",
					status: "completed",
					action: completedAction,
					results: completedResults,
				},
			},
		])

		expect(chunks).to.deep.equal([
			{
				type: "server_tool",
				function_id: "ws_1",
				provider_metadata: { item_id: "ws_1" },
				tool: ServerTool.WEB_SEARCH,
				phase: "started",
				input: startedAction,
			},
			{
				type: "server_tool",
				function_id: "ws_1",
				provider_metadata: { item_id: "ws_1" },
				tool: ServerTool.WEB_SEARCH,
				phase: "in_progress",
			},
			{
				type: "server_tool",
				function_id: "ws_1",
				provider_metadata: { item_id: "ws_1" },
				tool: ServerTool.WEB_SEARCH,
				phase: "searching",
			},
			{
				type: "server_tool",
				function_id: "ws_1",
				provider_metadata: { item_id: "ws_1" },
				tool: ServerTool.WEB_SEARCH,
				phase: "completed",
			},
			{
				type: "server_tool",
				function_id: "ws_1",
				provider_metadata: { item_id: "ws_1" },
				tool: ServerTool.WEB_SEARCH,
				phase: "completed",
				result: { action: completedAction, results: completedResults },
				// Only the Responses input item fields are kept for replay; search results are not.
				replay: {
					type: "hosted_tool",
					protocol: "openai_responses",
					blocks: [{ type: "web_search_call", id: "ws_1", status: "completed", action: completedAction }],
				},
			},
		])
		expect(chunks.some((chunk) => chunk.type === "tool_calls")).to.equal(false)
	})

	it("keeps no replay for a finished web_search_call that carries no action", async () => {
		const chunks = await collectChunks([
			{
				type: "response.output_item.done",
				output_index: 0,
				sequence_number: 1,
				item: { type: "web_search_call", id: "ws_bare", status: "completed" },
			},
		])

		expect(chunks).to.have.length(1)
		expect(chunks[0]).to.include({ phase: "completed", function_id: "ws_bare" })
		expect(chunks[0]).not.to.have.property("replay")
	})

	it("emits hosted image partials as ephemeral preview chunks", async () => {
		const result = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"
		const chunks = await collectChunks([
			{
				type: "response.output_item.added",
				item: { type: "image_generation_call", id: "ig_1", status: "in_progress" },
			},
			{
				type: "response.image_generation_call.partial_image",
				item_id: "ig_1",
				partial_image_index: 1,
				partial_image_b64: "secret-preview",
			},
			{
				type: "response.output_item.done",
				item: {
					type: "image_generation_call",
					id: "ig_1",
					status: "completed",
					result,
					revised_prompt: "A blue owl",
				},
			},
		])

		expect(chunks).to.deep.equal([
			{
				type: "server_tool",
				function_id: "ig_1",
				provider_metadata: { item_id: "ig_1" },
				tool: ServerTool.IMAGE_GENERATION,
				phase: "started",
			},
			{
				type: "server_tool",
				function_id: "ig_1",
				provider_metadata: { item_id: "ig_1" },
				tool: ServerTool.IMAGE_GENERATION,
				phase: "preview",
				result: { partialImageB64: "secret-preview", sequence: 1 },
			},
			{
				type: "server_tool",
				function_id: "ig_1",
				provider_metadata: { item_id: "ig_1" },
				tool: ServerTool.IMAGE_GENERATION,
				phase: "completed",
				result: { b64Json: result, revisedPrompt: "A blue owl" },
			},
		])
		expect(JSON.stringify(chunks.filter((chunk) => chunk.phase !== "preview"))).not.to.contain("secret-preview")
	})

	it("classifies official Responses cache write tokens separately from uncached input", async () => {
		const calculateCost = vi.fn(async () => 0)
		const chunks = await collectChunks(
			[
				{
					type: "response.completed",
					response: {
						id: "resp_cache_usage",
						usage: {
							input_tokens: 1_000,
							input_tokens_details: { cached_tokens: 500, cache_write_tokens: 300 },
							output_tokens: 25,
							output_tokens_details: { reasoning_tokens: 10 },
							total_tokens: 1_035,
						},
					},
				},
			],
			calculateCost,
		)

		expect(chunks).to.deep.equal([
			{
				type: "usage",
				inputTokens: 200,
				outputTokens: 25,
				cacheWriteTokens: 300,
				cacheReadTokens: 500,
				thoughtsTokenCount: 10,
				totalCost: 0,
				provider_metadata: { response_id: "resp_cache_usage" },
			},
		])
		// `output_tokens` already includes `reasoning_tokens`, so cost is never charged for them twice.
		expect(calculateCost.mock.calls).to.deep.equal([[{ id: "test-model" }, 1_000, 25, 300, 500]])
	})

	it("falls back to cache_miss_tokens for compatible Responses providers", async () => {
		const chunks = await collectChunks([
			{
				type: "response.completed",
				response: {
					id: "resp_compatible_usage",
					usage: {
						input_tokens: 700,
						input_tokens_details: { cached_tokens: 200, cache_miss_tokens: 100 },
						output_tokens: 20,
						total_tokens: 720,
					},
				},
			},
		])

		expect(chunks[0]).to.include({
			type: "usage",
			inputTokens: 400,
			cacheWriteTokens: 100,
			cacheReadTokens: 200,
		})
	})

	it("skips output_item events without an item payload instead of crashing", async () => {
		// Aborted or gateway-mangled streams can emit output_item.added/done
		// events with no item. This previously threw
		// "Cannot read properties of undefined (reading 'type')".
		const chunks = await collectChunks([
			{ type: "response.output_item.added", output_index: 0, sequence_number: 1 },
			{ type: "response.output_item.done", output_index: 0, sequence_number: 2 },
			{
				type: "response.output_item.done",
				output_index: 0,
				sequence_number: 3,
				item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file", arguments: "{}" },
			},
		])

		expect(chunks).to.deep.equal([
			{
				type: "tool_calls",
				function_id: "call_1",
				tool_call: { function: { name: "read_file", arguments: "{}" } },
				provider_metadata: { item_id: "fc_1" },
				phase: "delta",
			},
			{
				type: "tool_calls",
				function_id: "call_1",
				tool_call: { function: { name: "read_file" } },
				provider_metadata: { item_id: "fc_1" },
				phase: "completed",
			},
		])
	})

	it("skips reasoning_summary_part events without a part payload instead of crashing", async () => {
		// Gateway-mangled streams can emit reasoning_summary_part.added/done
		// events with no part. This previously threw
		// "Cannot read properties of undefined (reading 'text')".
		const chunks = await collectChunks([
			{ type: "response.reasoning_summary_part.added", item_id: "rs_1", output_index: 0, sequence_number: 1 },
			{ type: "response.reasoning_summary_part.done", item_id: "rs_1", output_index: 0, sequence_number: 2 },
			{
				type: "response.reasoning_summary_part.added",
				item_id: "rs_2",
				output_index: 0,
				sequence_number: 3,
				part: { type: "summary_text", text: "visible reasoning" },
			},
		])

		expect(chunks).to.deep.equal([
			{
				type: "reasoning",
				provider_metadata: { response_id: "rs_2" },
				reasoning: "visible reasoning",
			},
		])
	})

	it("preserves structured provider error details for a response.failed event", async () => {
		// A gateway or proxy can end a Responses stream with only
		// codex.rate_limits / codex.response.metadata / response.failed events.
		// Previously the generator ended without yielding anything, and
		// attemptApiRequest yielded undefined as a "successful first chunk",
		// crashing downstream on "Cannot read properties of undefined
		// (reading 'type')".
		let caught: unknown
		try {
			const stream = createAsyncIterable([
				{ type: "codex.rate_limits", sequence_number: 1 },
				{ type: "codex.response.metadata", sequence_number: 2 },
				{
					type: "response.failed",
					sequence_number: 3,
					response: {
						id: "resp_failed_1",
						status: "failed",
						error: { code: "server_error", message: "upstream exploded", param: "input" },
					},
				},
			])
			stream._request_id = "req_failed_1"
			for await (const _ of handleResponsesApiStreamResponse(stream, { id: "test-model" }, async () => 0)) {
				// The failed event must throw before yielding a successful terminal value.
			}
		} catch (error) {
			caught = error
		}
		expect(caught).to.be.instanceOf(Error)
		expect(caught).to.include({
			name: "ResponsesApiError",
			code: "server_error",
			request_id: "req_failed_1",
			response_id: "resp_failed_1",
		})
		expect((caught as Error).message).to.include("server_error: upstream exploded")
		expect((caught as { details?: unknown }).details).to.deep.equal({
			code: "server_error",
			message: "upstream exploded",
			param: "input",
		})
	})

	it("does not append completed argument snapshots after streaming function-call deltas", async () => {
		const completeArguments = JSON.stringify({
			path: "src/generated.ts",
			content: "export const value = 1\n",
		})
		const splitAt = Math.floor(completeArguments.length / 2)
		const chunks = await collectChunks([
			{
				type: "response.output_item.added",
				output_index: 0,
				sequence_number: 1,
				item: { type: "function_call", id: "fc_write", call_id: "call_write", name: "write_to_file", arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_write",
				output_index: 0,
				sequence_number: 2,
				delta: completeArguments.slice(0, splitAt),
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_write",
				output_index: 0,
				sequence_number: 3,
				delta: completeArguments.slice(splitAt),
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_write",
				output_index: 0,
				sequence_number: 4,
				name: "write_to_file",
				arguments: completeArguments,
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				sequence_number: 5,
				item: {
					type: "function_call",
					id: "fc_write",
					call_id: "call_write",
					name: "write_to_file",
					arguments: completeArguments,
				},
			},
		])

		expect(chunks.map((chunk) => chunk.tool_call?.function.arguments).filter((value) => value !== undefined)).to.deep.equal([
			completeArguments.slice(0, splitAt),
			completeArguments.slice(splitAt),
		])
	})

	it("emits an explicit completion boundary after streamed function arguments finish", async () => {
		const completeArguments = JSON.stringify({ response: "A complete plan", needs_more_exploration: false })
		const chunks = await collectChunks([
			{
				type: "response.output_item.added",
				output_index: 0,
				sequence_number: 1,
				item: { type: "function_call", id: "fc_plan", call_id: "call_plan", name: "make_plan", arguments: "" },
			},
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_plan",
				output_index: 0,
				sequence_number: 2,
				delta: completeArguments,
			},
			{
				type: "response.function_call_arguments.done",
				item_id: "fc_plan",
				output_index: 0,
				sequence_number: 3,
				name: "make_plan",
				arguments: completeArguments,
			},
		])

		expect(chunks).to.deep.equal([
			{
				type: "tool_calls",
				function_id: "call_plan",
				tool_call: { function: { name: "make_plan", arguments: completeArguments } },
				provider_metadata: { item_id: "fc_plan" },
				phase: "delta",
			},
			{
				type: "tool_calls",
				function_id: "call_plan",
				tool_call: { function: { name: "make_plan" } },
				provider_metadata: { item_id: "fc_plan" },
				phase: "completed",
			},
		])
	})

	it("throws when a Responses request is truncated before a tool call completes", async () => {
		let caught: unknown
		try {
			await collectChunks([
				{
					type: "response.output_item.added",
					output_index: 0,
					sequence_number: 1,
					item: { type: "function_call", id: "fc_write", call_id: "call_write", name: "write_to_file", arguments: "" },
				},
				{
					type: "response.function_call_arguments.delta",
					item_id: "fc_write",
					output_index: 0,
					sequence_number: 2,
					delta: '{"path":"src/generated.ts","content":"export const value',
				},
				{
					type: "response.incomplete",
					sequence_number: 3,
					response: {
						status: "incomplete",
						incomplete_details: { reason: "max_output_tokens" },
					},
				},
			])
		} catch (error) {
			caught = error
		}

		expect(caught).to.be.instanceOf(OutputLimitExceededError)
		expect(caught).to.deep.include({
			code: "output_limit_exceeded",
			protocol: "openai_responses",
			reason: "max_output_tokens",
		})
	})

	it("emits a failed server_tool event for a failed web_search_call item", async () => {
		const action = { type: "search", query: "Dline" }
		const chunks = await collectChunks([
			{
				type: "response.output_item.done",
				output_index: 0,
				sequence_number: 1,
				item: { type: "web_search_call", id: "ws_error", status: "failed", action },
			},
		])

		expect(chunks).to.deep.equal([
			{
				type: "server_tool",
				function_id: "ws_error",
				provider_metadata: { item_id: "ws_error" },
				tool: ServerTool.WEB_SEARCH,
				phase: "failed",
				error: action,
				replay: {
					type: "hosted_tool",
					protocol: "openai_responses",
					blocks: [{ type: "web_search_call", id: "ws_error", status: "failed", action }],
				},
			},
		])
	})
})
