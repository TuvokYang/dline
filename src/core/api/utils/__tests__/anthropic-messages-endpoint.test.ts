import { ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it, vi } from "vitest"
import { streamAnthropicMessagesEndpoint } from "../anthropic-messages-endpoint"

function createAsyncIterable(events: readonly unknown[], onClose?: () => void): AsyncIterable<any> {
	return {
		async *[Symbol.asyncIterator]() {
			try {
				for (const event of events) yield event
			} finally {
				onClose?.()
			}
		},
	}
}

async function collect(stream: AsyncIterable<unknown>): Promise<any[]> {
	const chunks: any[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}

const messageStart = (
	inputTokens: number,
	options: { cacheWriteTokens?: number; cacheReadTokens?: number; webSearchRequests?: number } = {},
) => ({
	type: "message_start",
	message: {
		usage: {
			input_tokens: inputTokens,
			output_tokens: 0,
			cache_creation_input_tokens: options.cacheWriteTokens ?? 0,
			cache_read_input_tokens: options.cacheReadTokens ?? 0,
			server_tool_use:
				options.webSearchRequests === undefined
					? null
					: { web_search_requests: options.webSearchRequests, web_fetch_requests: 0 },
		},
	},
})

const messageDelta = (stopReason: "end_turn" | "pause_turn" | "tool_use" | null, outputTokens: number) => ({
	type: "message_delta",
	delta: { stop_reason: stopReason, stop_sequence: null },
	usage: {
		input_tokens: null,
		output_tokens: outputTokens,
		cache_creation_input_tokens: null,
		cache_read_input_tokens: null,
		server_tool_use: null,
		output_tokens_details: null,
	},
})

describe("streamAnthropicMessagesEndpoint", () => {
	it("replays raw pause_turn blocks in order and reports cumulative usage across requests", async () => {
		const citation = {
			type: "web_search_result_location",
			cited_text: "Dline result",
			encrypted_index: "encrypted",
			title: "Result title",
			url: "https://example.test/result",
		}
		const searchResult = [
			{
				type: "web_search_result",
				url: "https://example.test/result",
				title: "Result title",
				page_age: null,
				encrypted_content: "encrypted-result",
			},
		]
		const responses = [
			[
				messageStart(10, { cacheWriteTokens: 2, cacheReadTokens: 3, webSearchRequests: 1 }),
				{
					type: "content_block_start",
					index: 0,
					content_block: { type: "thinking", thinking: "", signature: "" },
				},
				{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Check sources" } },
				{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-final" } },
				{ type: "content_block_stop", index: 0 },
				{
					type: "content_block_start",
					index: 1,
					content_block: {
						type: "server_tool_use",
						id: "srv_pause_replay",
						name: "web_search",
						input: {},
						caller: { type: "direct" },
					},
				},
				{
					type: "content_block_delta",
					index: 1,
					delta: { type: "input_json_delta", partial_json: '{"query":"Dline"}' },
				},
				{ type: "content_block_stop", index: 1 },
				{
					type: "content_block_start",
					index: 2,
					content_block: {
						type: "web_search_tool_result",
						tool_use_id: "srv_pause_replay",
						content: searchResult,
						caller: { type: "direct" },
					},
				},
				{ type: "content_block_stop", index: 2 },
				{
					type: "content_block_start",
					index: 3,
					content_block: { type: "text", text: "", citations: null },
				},
				{ type: "content_block_delta", index: 3, delta: { type: "text_delta", text: "Found it" } },
				{ type: "content_block_delta", index: 3, delta: { type: "citations_delta", citation } },
				{ type: "content_block_stop", index: 3 },
				messageDelta("pause_turn", 5),
				{ type: "message_stop" },
			],
			[
				messageStart(20),
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "Done", citations: null } },
				{ type: "content_block_stop", index: 0 },
				messageDelta("end_turn", 7),
				{ type: "message_stop" },
			],
		]
		const requests: any[][] = []
		const openStream = vi.fn(async (messages: any[]) => {
			requests.push(JSON.parse(JSON.stringify(messages)) as any[])
			const events = responses.shift()
			if (!events) throw new Error("Unexpected continuation")
			return createAsyncIterable(events)
		})

		const chunks = await collect(
			streamAnthropicMessagesEndpoint({
				messages: [{ role: "user", content: "Search Dline" }],
				openStream,
			}),
		)

		expect(openStream).toHaveBeenCalledTimes(2)
		expect(requests[0]).toEqual([{ role: "user", content: "Search Dline" }])
		expect(requests[1].at(-1)).toEqual({
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Check sources", signature: "sig-final" },
				{
					type: "server_tool_use",
					id: "srv_pause_replay",
					name: "web_search",
					input: { query: "Dline" },
					caller: { type: "direct" },
				},
				{
					type: "web_search_tool_result",
					tool_use_id: "srv_pause_replay",
					content: searchResult,
					caller: { type: "direct" },
				},
				{ type: "text", text: "Found it", citations: [citation] },
			],
		})
		const usage = chunks.filter((chunk) => chunk.type === "usage").at(-1)
		expect(usage).toMatchObject({
			usageMode: "snapshot",
			inputTokens: 30,
			outputTokens: 12,
			cacheWriteTokens: 2,
			cacheReadTokens: 3,
			serverToolUsage: { webSearchRequests: 1, webFetchRequests: 0 },
		})
	})

	it("keeps hosted-tool identity across a pause_turn response boundary", async () => {
		const responses = [
			[
				{
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "server_tool_use",
						id: "srv_cross_response",
						name: "web_search",
						input: { query: "Dline" },
						caller: { type: "direct" },
					},
				},
				messageDelta("pause_turn", 1),
			],
			[
				{
					type: "content_block_start",
					index: 0,
					content_block: {
						type: "web_search_tool_result",
						tool_use_id: "srv_cross_response",
						content: [],
						caller: { type: "direct" },
					},
				},
				messageDelta("end_turn", 1),
			],
		]
		const chunks = await collect(
			streamAnthropicMessagesEndpoint({
				messages: [{ role: "user", content: "Search" }],
				openStream: async () => createAsyncIterable(responses.shift() ?? []),
			}),
		)

		expect(
			chunks
				.filter((chunk) => chunk.type === "server_tool")
				.map((chunk) => ({ phase: chunk.phase, tool: chunk.tool, functionId: chunk.function_id })),
		).toEqual([
			{ phase: "started", tool: ServerTool.WEB_SEARCH, functionId: "srv_cross_response" },
			{ phase: "completed", tool: ServerTool.WEB_SEARCH, functionId: "srv_cross_response" },
		])
	})

	it("attaches the verbatim call and result to a hosted fetch paired across a pause_turn boundary", async () => {
		const call = {
			type: "server_tool_use",
			id: "srv_fetch_cross",
			name: "web_fetch",
			input: { url: "https://example.test/page" },
			caller: { type: "direct" },
		}
		const result = {
			type: "web_fetch_tool_result",
			tool_use_id: "srv_fetch_cross",
			content: { type: "web_fetch_result", url: "https://example.test/page", content: { type: "document" } },
			caller: { type: "direct" },
		}
		const responses = [
			[{ type: "content_block_start", index: 0, content_block: call }, messageDelta("pause_turn", 1)],
			[{ type: "content_block_start", index: 0, content_block: result }, messageDelta("end_turn", 1)],
		]
		const chunks = await collect(
			streamAnthropicMessagesEndpoint({
				messages: [{ role: "user", content: "Fetch" }],
				openStream: async () => createAsyncIterable(responses.shift() ?? []),
			}),
		)

		const completed = chunks.find((chunk) => chunk.type === "server_tool" && chunk.phase === "completed")
		expect(completed?.replay).toEqual({ type: "hosted_tool", protocol: "anthropic_messages", blocks: [call, result] })
	})

	it("fails a hosted call left open by the final response and names its stop reason", async () => {
		const chunks = await collect(
			streamAnthropicMessagesEndpoint({
				messages: [{ role: "user", content: "Fetch" }],
				openStream: async () =>
					createAsyncIterable([
						{
							type: "content_block_start",
							index: 0,
							content_block: {
								type: "server_tool_use",
								id: "srv_fetch_open",
								name: "web_fetch",
								input: { url: "https://example.test/slow" },
								caller: { type: "direct" },
							},
						},
						{ type: "content_block_stop", index: 0 },
						messageDelta("tool_use", 3),
					]),
			}),
		)

		const lifecycle = chunks.filter((chunk) => chunk.type === "server_tool")
		expect(lifecycle.map((chunk) => chunk.phase)).toEqual(["started", "failed"])
		expect(lifecycle.at(-1)).toMatchObject({
			function_id: "srv_fetch_open",
			tool: ServerTool.WEB_FETCH,
			error: "Anthropic response ended (stop_reason: tool_use) before the hosted web_fetch call returned a result.",
		})
	})

	it("fails closed when pause_turn has no assistant content", async () => {
		const stream = streamAnthropicMessagesEndpoint({
			messages: [{ role: "user", content: "Search" }],
			openStream: async () => createAsyncIterable([messageDelta("pause_turn", 1)]),
		})

		await expect(collect(stream)).rejects.toThrow(/without assistant content/i)
	})

	it("fails closed after the configured pause_turn continuation limit", async () => {
		const openStream = vi.fn(async () =>
			createAsyncIterable([
				{ type: "content_block_start", index: 0, content_block: { type: "text", text: "continue", citations: null } },
				messageDelta("pause_turn", 1),
			]),
		)
		const stream = streamAnthropicMessagesEndpoint({
			messages: [{ role: "user", content: "Search" }],
			openStream,
			maxPauseTurnContinuations: 1,
		})

		await expect(collect(stream)).rejects.toThrow(/continuation limit \(1\)/i)
		expect(openStream).toHaveBeenCalledTimes(2)
	})

	it("closes the active provider stream when its consumer cancels", async () => {
		let closed = false
		const stream = streamAnthropicMessagesEndpoint({
			messages: [{ role: "user", content: "Start" }],
			openStream: async () =>
				createAsyncIterable(
					[
						{
							type: "content_block_start",
							index: 0,
							content_block: { type: "text", text: "partial", citations: null },
						},
					],
					() => {
						closed = true
					},
				),
		})

		await expect(stream.next()).resolves.toMatchObject({ value: { type: "text", text: "partial" }, done: false })
		await stream.return(undefined)
		expect(closed).toBe(true)
	})
})
