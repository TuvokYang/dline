import { resolveWebSearchRoutingPlan } from "@core/api/server-tools"
import type { ApiStreamServerToolChunk } from "@core/api/transform/stream"
import type { MessageStateHandler } from "@core/task/message-state"
import type { UiMessage } from "@shared/ExtensionMessage"
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
function messageStore(): MessageStateHandler {
	const rows = new Map<number, UiMessage>()
	return {
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
})
