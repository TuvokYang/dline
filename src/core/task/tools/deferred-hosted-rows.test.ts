import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ClineAssistantHostedToolBlock, ClineStorageMessage } from "@shared/messages/content"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { planDeferredHostedRows, readDeferredHostedRow } from "./deferred-hosted-rows"

const callSegment: ClineAssistantHostedToolBlock = {
	type: "hosted_tool",
	protocol: "anthropic_messages",
	segment: "call",
	blocks: [{ type: "server_tool_use", id: "srvtoolu_deferred", name: "web_search", input: { query: "deferred search" } }],
}
const resultSegment: ClineAssistantHostedToolBlock = {
	type: "hosted_tool",
	protocol: "anthropic_messages",
	segment: "result",
	blocks: [{ type: "web_search_tool_result", tool_use_id: "srvtoolu_deferred", content: [] }],
}
const toolUse = {
	type: "tool_use" as const,
	function_id: "toolu_read",
	dline_tid: "trace-read",
	name: "read_file",
	input: { path: "a.ts" },
}
const toolResult = { type: "tool_result" as const, function_id: "toolu_read", dline_tid: "trace-read", content: "file body" }

const deferredTurn: ClineStorageMessage[] = [
	{ role: "user", content: [{ type: "text", text: "search and read" }] },
	{ role: "assistant", content: [callSegment, toolUse] },
	{ role: "user", content: [toolResult] },
]
const anthropicRequest = { protocol: "anthropic_messages" as const, replayHostedTools: new Set(["web_search"]) }

function searchRow(ts: number, status: string, hostedCall?: { functionId: string; traceId: string }): ClineMessage {
	return {
		ts,
		type: "say",
		say: "tool",
		text: JSON.stringify({
			tool: "webSearch",
			path: "deferred search",
			content: "Searching for: deferred search",
			operationIsLocatedInWorkspace: false,
			webSearch: {
				schemaVersion: 1,
				status,
				source: { id: "anthropic-hosted", label: "Anthropic Web Search", execution: "hosted", provider: "anthropic" },
				query: "deferred search",
				operation: { type: "search", queries: ["deferred search"] },
				...(hostedCall ? { hostedCall } : {}),
			},
		}),
	}
}

function fetchRow(ts: number): ClineMessage {
	return {
		ts,
		type: "say",
		say: "tool",
		text: JSON.stringify({
			tool: "webFetch",
			path: "https://example.com/doc",
			content: "Fetching URL: https://example.com/doc",
			operationIsLocatedInWorkspace: false,
			webFetch: {
				schemaVersion: 1,
				status: "deferred",
				source: {
					id: "claude-code-hosted",
					label: "Claude Code Web Fetch",
					execution: "hosted",
					provider: "claude-code",
				},
				url: "https://example.com/doc",
				hostedCall: { functionId: "srvtoolu_fetch", traceId: "trace-fetch" },
			},
		}),
	}
}

const deferredSearch = searchRow(100, "deferred", { functionId: "srvtoolu_deferred", traceId: "trace-search" })

describe("readDeferredHostedRow", () => {
	it("recovers the hosted call identity and subject from a deferred Web Search row", () => {
		expect(readDeferredHostedRow(deferredSearch)).toEqual({
			ts: 100,
			functionId: "srvtoolu_deferred",
			dlineTid: "trace-search",
			tool: ServerTool.WEB_SEARCH,
			providerId: "anthropic",
			query: "deferred search",
			operation: { type: "search", queries: ["deferred search"] },
		})
	})

	it("recovers the fetched URL as the call input of a deferred Web Fetch row", () => {
		expect(readDeferredHostedRow(fetchRow(200))).toEqual({
			ts: 200,
			functionId: "srvtoolu_fetch",
			dlineTid: "trace-fetch",
			tool: ServerTool.WEB_FETCH,
			providerId: "claude-code",
			query: "https://example.com/doc",
			operation: { type: "unknown" },
			input: { url: "https://example.com/doc" },
		})
	})

	it("ignores settled rows and rows without a hosted call identity", () => {
		expect(
			readDeferredHostedRow(searchRow(1, "completed", { functionId: "srvtoolu_deferred", traceId: "t" })),
		).toBeUndefined()
		expect(readDeferredHostedRow(searchRow(2, "deferred"))).toBeUndefined()
		expect(readDeferredHostedRow({ ts: 3, type: "say", say: "text", text: "deferred" })).toBeUndefined()
		expect(readDeferredHostedRow({ ts: 4, type: "say", say: "tool", text: "{not json" })).toBeUndefined()
	})
})

describe("planDeferredHostedRows", () => {
	it("carries a deferred row whose call the request resumes", () => {
		const plan = planDeferredHostedRows([deferredSearch], deferredTurn, anthropicRequest)

		expect(plan.carried.map((row) => row.functionId)).toEqual(["srvtoolu_deferred"])
		expect(plan.abandoned).toEqual([])
	})

	it("abandons a deferred row when the request cannot resume its call", () => {
		const otherProtocol = planDeferredHostedRows([deferredSearch], deferredTurn, { protocol: undefined })
		const undeclared = planDeferredHostedRows([deferredSearch], deferredTurn, {
			protocol: "anthropic_messages",
			replayHostedTools: new Set(["web_fetch"]),
		})
		const movedOn = planDeferredHostedRows(
			[deferredSearch],
			[...deferredTurn, { role: "assistant", content: [{ type: "text", text: "answer" }] }],
			anthropicRequest,
		)
		const compacted = planDeferredHostedRows([deferredSearch], [deferredTurn[0]], anthropicRequest)

		for (const plan of [otherProtocol, undeclared, movedOn, compacted]) {
			expect(plan.carried).toEqual([])
			expect(plan.abandoned.map((row) => row.ts)).toEqual([100])
		}
	})

	it("leaves a deferred row alone once history already holds its result", () => {
		const plan = planDeferredHostedRows(
			[deferredSearch],
			[...deferredTurn, { role: "assistant", content: [resultSegment, { type: "text", text: "answer" }] }],
			anthropicRequest,
		)

		expect(plan).toEqual({ carried: [], abandoned: [] })
	})
})
