import { resolveWebSearchRoutingPlan } from "@core/api/server-tools"
import type { ApiStreamServerToolChunk } from "@core/api/transform/stream"
import type { MessageStateHandler } from "@core/task/message-state"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { ClineStorageMessage } from "@shared/messages/content"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { HostedServerToolPresenter } from "../HostedServerToolPresenter"

const hostedPlan = resolveWebSearchRoutingPlan({
	enabled: true,
	modelInfo: { capabilities: { tools: [ServerTool.WEB_SEARCH] } },
	selectedApiFormat: ApiFormat.OPENAI_RESPONSES,
	localAvailable: true,
	remoteAdapterAvailable: true,
})

function chunk(phase: ApiStreamServerToolChunk["phase"], result?: unknown): ApiStreamServerToolChunk {
	return {
		type: "server_tool",
		function_id: "provider-call-1",
		dline_tid: "trace-1",
		tool: ServerTool.WEB_SEARCH,
		phase,
		input: { query: "hosted query" },
		...(result === undefined ? {} : { result }),
	}
}

/** Keeps the latest row per id, as the message store replaces a row in place. */
function messageStore(rows = new Map<number, UiMessage>()): MessageStateHandler {
	return {
		get clineMessages() {
			return [...rows.values()]
		},
		upsertTransientClineMessage: (row: UiMessage) => {
			rows.set(row.ts, row)
		},
		beginDurableClineMessage: (row: UiMessage) => {
			rows.set(row.ts, row)
			return { message: row, persistence: Promise.resolve(row) }
		},
	} as unknown as MessageStateHandler
}

function searchItems(row: UiMessage | undefined): unknown[] {
	return JSON.parse(row?.text ?? "{}").webSearch?.items ?? []
}

function presentation(row: UiMessage | undefined): Record<string, unknown> {
	const tool = JSON.parse(row?.text ?? "{}")
	return tool.webSearch ?? tool.webFetch ?? {}
}

function beginSession(rows: Map<number, UiMessage>, providerId = "anthropic") {
	let nextId = 100
	const presenter = new HostedServerToolPresenter("task-1", messageStore(rows), () => ++nextId)
	return presenter.begin({
		providerId,
		webSearchRoutingPlan: hostedPlan,
		imageGeneration: { enabled: false },
	} as never)
}

/** A turn whose hosted search the provider deferred behind a client tool, answered by that tool's result. */
const deferredTurn: ClineStorageMessage[] = [
	{ role: "user", content: [{ type: "text", text: "search and read" }] },
	{
		role: "assistant",
		content: [
			{
				type: "hosted_tool",
				protocol: "anthropic_messages",
				segment: "call",
				blocks: [{ type: "server_tool_use", id: "srvtoolu_deferred", name: "web_search", input: { query: "q" } }],
			},
			{ type: "tool_use", function_id: "toolu_read", dline_tid: "trace-read", name: "read_file", input: { path: "a.ts" } },
		],
	},
	{ role: "user", content: [{ type: "tool_result", function_id: "toolu_read", dline_tid: "trace-read", content: "body" }] },
]

function deferredRow(ts: number, tool: "webSearch" | "webFetch", functionId: string, traceId: string): UiMessage {
	const source = { id: "claude-code-hosted", label: "Claude Code Web", execution: "hosted", provider: "claude-code" }
	const hostedCall = { functionId, traceId }
	const body =
		tool === "webSearch"
			? { webSearch: { schemaVersion: 1, status: "deferred", source, query: "q", hostedCall } }
			: { webFetch: { schemaVersion: 1, status: "deferred", source, url: "https://example.com/doc", hostedCall } }
	return {
		ts,
		type: "say",
		say: "tool",
		text: JSON.stringify({ tool, path: "q", operationIsLocatedInWorkspace: false, ...body }),
	}
}

describe("HostedServerToolPresenter", () => {
	// A late result replaces the durable row in place. The message count does not
	// change, which is the only thing the view refetches on, so a row that is
	// only stored never reaches a view that already drew the completed card.
	it("pushes the terminal row, and its late result, to the view", async () => {
		const published: UiMessage[] = []
		let nextId = 100
		const presenter = new HostedServerToolPresenter("task-1", messageStore(), () => ++nextId, {
			publish: (row) => published.push(row),
		})
		const session = presenter.begin({
			providerId: "openai",
			webSearchRoutingPlan: hostedPlan,
			imageGeneration: { enabled: false },
		} as never)

		await session.consume(chunk("started"))
		await session.consume(chunk("completed"))
		await session.consume(
			chunk("completed", {
				action: { type: "search", query: "hosted query" },
				results: [{ title: "Dline", url: "https://example.com/dline" }],
			}),
		)

		expect(new Set(published.map((row) => row.ts)).size).toBe(1)
		const terminal = published.filter((row) => row.partial === false)
		expect(terminal).toHaveLength(2)
		expect(searchItems(terminal[0])).toEqual([])
		expect(searchItems(terminal[1])).toHaveLength(1)
	})

	// The row is the durable record of a deferral; the next request reads the call identity back from it.
	it("writes a deferred call as a durable row that names its hosted call", async () => {
		const rows = new Map<number, UiMessage>()
		const session = beginSession(rows)

		await session.consume(chunk("deferred"))

		const [row] = [...rows.values()]
		expect(row.partial).toBe(false)
		expect(presentation(row)).toMatchObject({
			status: "deferred",
			hostedCall: { functionId: "provider-call-1", traceId: "trace-1" },
		})
	})

	it("completes a resumed deferred row in place and fails one no request can resume", async () => {
		const rows = new Map<number, UiMessage>([
			[10, deferredRow(10, "webSearch", "srvtoolu_deferred", "trace-search")],
			[20, deferredRow(20, "webFetch", "srvtoolu_gone", "trace-fetch")],
		])
		const session = beginSession(rows)

		const carried = await session.resumeDeferred?.({
			history: deferredTurn,
			protocol: "anthropic_messages",
			replayHostedTools: new Set(["web_search"]),
		})

		expect(carried).toEqual(new Map([["srvtoolu_deferred", "trace-search"]]))
		const abandoned = presentation(rows.get(20))
		expect(abandoned).toMatchObject({ status: "failed", source: { provider: "claude-code" } })
		expect(abandoned.error).toContain("never ran this deferred hosted call")
		expect(abandoned.hostedCall).toBeUndefined()
		expect(presentation(rows.get(10)).status).toBe("deferred")

		await session.consume({
			type: "server_tool",
			function_id: "srvtoolu_deferred",
			dline_tid: "trace-search",
			tool: ServerTool.WEB_SEARCH,
			phase: "completed",
			result: { results: [{ title: "Dline", url: "https://example.com/dline" }] },
		})

		expect([...rows.keys()]).toEqual([10, 20])
		const completed = presentation(rows.get(10))
		expect(completed.status).toBe("completed")
		expect(completed.hostedCall).toBeUndefined()
	})
})
