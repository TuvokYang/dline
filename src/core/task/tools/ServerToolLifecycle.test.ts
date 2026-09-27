import { resolveWebSearchRoutingPlan } from "@core/api/server-tools"
import type { ApiStreamServerToolChunk } from "@core/api/transform/stream"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { ServerToolLifecycle } from "./ServerToolLifecycle"

const hostedPlan = resolveWebSearchRoutingPlan({
	enabled: true,
	modelInfo: { capabilities: { tools: [ServerTool.WEB_SEARCH] } },
	selectedApiFormat: ApiFormat.OPENAI_RESPONSES,
	localAvailable: true,
	remoteAdapterAvailable: true,
})

function chunk(
	phase: ApiStreamServerToolChunk["phase"],
	input: unknown = { query: "lifecycle query" },
): ApiStreamServerToolChunk {
	return {
		type: "server_tool",
		function_id: "provider-call-1",
		dline_tid: "trace-1",
		tool: ServerTool.WEB_SEARCH,
		phase,
		input,
	}
}

describe("ServerToolLifecycle", () => {
	it("admits only hosted Web Search and emits one terminal update", async () => {
		const updates: Array<{ status: string; partial: boolean }> = []
		const lifecycle = new ServerToolLifecycle(hostedPlan, true, (update) => {
			updates.push({ status: update.status, partial: update.partial })
		})

		await lifecycle.consume(chunk("started"))
		await lifecycle.consume(chunk("searching"))
		await lifecycle.consume(chunk("completed"))
		await lifecycle.consume(chunk("completed"))
		await lifecycle.consume(chunk("searching"))

		expect(updates).toEqual([
			{ status: "started", partial: true },
			{ status: "started", partial: true },
			{ status: "completed", partial: false },
		])
	})

	it("enriches a completed hosted call when the provider result arrives later", async () => {
		const result = {
			type: "search",
			query: "lifecycle query",
			sources: [{ type: "url", url: "https://example.com/dline" }],
		}
		const updates: Array<{ status: string; result?: unknown }> = []
		const lifecycle = new ServerToolLifecycle(hostedPlan, true, (update) => {
			updates.push({ status: update.status, result: update.result })
		})

		await lifecycle.consume(chunk("started"))
		await lifecycle.consume(chunk("completed"))
		await lifecycle.consume({ ...chunk("completed"), result })
		await lifecycle.consume({ ...chunk("completed"), result })

		expect(updates).toEqual([
			{ status: "started", result: undefined },
			{ status: "completed", result: undefined },
			{ status: "completed", result },
		])
	})

	it("enriches terminal-first hosted calls with a late query and result without duplicate updates", async () => {
		const result = {
			action: {
				query: "late lifecycle query",
				sources: [{ type: "url", url: "https://example.com/late" }],
			},
		}
		const updates: Array<{ status: string; query: string; result?: unknown }> = []
		const lifecycle = new ServerToolLifecycle(hostedPlan, true, (update) => {
			updates.push({ status: update.status, query: update.query, result: update.result })
		})

		await lifecycle.consume(chunk("completed", null))
		await lifecycle.consume(chunk("started", { query: "late lifecycle query" }))
		await lifecycle.consume({ ...chunk("completed", null), result })
		await lifecycle.consume({ ...chunk("completed", null), result })

		expect(updates).toEqual([
			{ status: "completed", query: "Provider-hosted web search", result: undefined },
			{ status: "completed", query: "late lifecycle query", result: undefined },
			{ status: "completed", query: "late lifecycle query", result },
		])
	})

	it("keeps multiple hosted actions independent and exposes their normalized operation", async () => {
		const updates: Array<{
			dlineTid: string
			functionId: string
			status: string
			operation: unknown
		}> = []
		const lifecycle = new ServerToolLifecycle(hostedPlan, true, (update) => {
			updates.push({
				dlineTid: update.dlineTid,
				functionId: update.functionId,
				status: update.status,
				operation: update.operation,
			})
		})

		await lifecycle.consume(chunk("started", { type: "search", queries: ["Dline hosted search", "OpenAI Responses"] }))
		await lifecycle.consume(chunk("completed", { type: "search", queries: ["Dline hosted search", "OpenAI Responses"] }))
		await lifecycle.consume({
			...chunk("started", { type: "open_page", url: "https://example.com/current" }),
			function_id: "provider-call-2",
			dline_tid: "trace-2",
		})
		await lifecycle.consume({
			...chunk("completed", { type: "open_page", url: "https://example.com/current" }),
			function_id: "provider-call-2",
			dline_tid: "trace-2",
		})

		expect(updates).toEqual([
			{
				dlineTid: "trace-1",
				functionId: "provider-call-1",
				status: "started",
				operation: { type: "search", queries: ["Dline hosted search", "OpenAI Responses"] },
			},
			{
				dlineTid: "trace-1",
				functionId: "provider-call-1",
				status: "completed",
				operation: { type: "search", queries: ["Dline hosted search", "OpenAI Responses"] },
			},
			{
				dlineTid: "trace-2",
				functionId: "provider-call-2",
				status: "started",
				operation: { type: "open_page", url: "https://example.com/current" },
			},
			{
				dlineTid: "trace-2",
				functionId: "provider-call-2",
				status: "completed",
				operation: { type: "open_page", url: "https://example.com/current" },
			},
		])
	})

	it("enriches a terminal-first call with a late action without changing its identity", async () => {
		const result = {
			action: {
				type: "find_in_page",
				url: "https://example.com/docs",
				pattern: "hosted search action",
			},
			sources: [{ type: "url", url: "https://example.com/docs" }],
		}
		const updates: Array<{
			dlineTid: string
			functionId: string
			status: string
			operation: unknown
			result?: unknown
		}> = []
		const lifecycle = new ServerToolLifecycle(hostedPlan, true, (update) => {
			updates.push({
				dlineTid: update.dlineTid,
				functionId: update.functionId,
				status: update.status,
				operation: update.operation,
				result: update.result,
			})
		})

		await lifecycle.consume(chunk("completed", null))
		await lifecycle.consume(
			chunk("started", {
				type: "find_in_page",
				url: "https://example.com/docs",
				pattern: "hosted search action",
			}),
		)
		await lifecycle.consume({ ...chunk("completed", null), result })
		await lifecycle.consume({ ...chunk("completed", null), result })

		expect(updates).toEqual([
			{
				dlineTid: "trace-1",
				functionId: "provider-call-1",
				status: "completed",
				operation: { type: "unknown" },
				result: undefined,
			},
			{
				dlineTid: "trace-1",
				functionId: "provider-call-1",
				status: "completed",
				operation: {
					type: "find_in_page",
					url: "https://example.com/docs",
					pattern: "hosted search action",
				},
				result: undefined,
			},
			{
				dlineTid: "trace-1",
				functionId: "provider-call-1",
				status: "completed",
				operation: {
					type: "find_in_page",
					url: "https://example.com/docs",
					pattern: "hosted search action",
				},
				result,
			},
		])
	})

	it("preserves a failed hosted action when the provider carries it in the error payload", async () => {
		const updates: Array<{ status: string; query: string; operation: unknown; error?: string }> = []
		const lifecycle = new ServerToolLifecycle(hostedPlan, true, (update) => {
			updates.push({
				status: update.status,
				query: update.query,
				operation: update.operation,
				error: update.error,
			})
		})

		await lifecycle.consume({
			...chunk("failed", null),
			error: { type: "open_page", url: "https://example.com/failed-page" },
		})

		expect(updates).toEqual([
			{
				status: "failed",
				query: "https://example.com/failed-page",
				operation: { type: "open_page", url: "https://example.com/failed-page" },
				error: "Provider-hosted web search failed",
			},
		])
	})

	it("does not revive a failed hosted call with late query or result events", async () => {
		const result = {
			action: {
				query: "ignored late query",
				sources: [{ type: "url", url: "https://example.com/ignored" }],
			},
		}
		const updates: Array<{ status: string; query: string; result?: unknown }> = []
		const lifecycle = new ServerToolLifecycle(hostedPlan, true, (update) => {
			updates.push({ status: update.status, query: update.query, result: update.result })
		})

		await lifecycle.consume({ ...chunk("failed", null), error: "hosted search failed" })
		await lifecycle.consume(chunk("started", { query: "ignored late query" }))
		await lifecycle.consume({ ...chunk("completed", null), result })

		expect(updates).toEqual([{ status: "failed", query: "Provider-hosted web search", result: undefined }])
	})

	it("preserves the provider-compressed hosted result on the terminal update", async () => {
		const result = [
			{
				type: "web_search_result",
				title: "Dline",
				url: "https://example.com/dline",
			},
		]
		const updates: Array<{ status: string; result?: unknown }> = []
		const lifecycle = new ServerToolLifecycle(hostedPlan, true, (update) => {
			updates.push({ status: update.status, result: update.result })
		})

		await lifecycle.consume(chunk("started"))
		await lifecycle.consume({ ...chunk("completed"), result })

		expect(updates).toEqual([
			{ status: "started", result: undefined },
			{ status: "completed", result },
		])
	})

	it("closes an open call on stream termination and ignores later provider events", async () => {
		const updates: Array<{ status: string; error?: string }> = []
		const lifecycle = new ServerToolLifecycle(hostedPlan, true, (update) => {
			updates.push({ status: update.status, error: update.error })
		})

		await lifecycle.consume(chunk("started"))
		await lifecycle.finalizeOpen("stream ended before hosted result")
		await lifecycle.finalizeOpen("second finalization")
		await lifecycle.consume(chunk("completed"))

		expect(updates).toEqual([{ status: "started" }, { status: "failed", error: "stream ended before hosted result" }])
	})

	it("ignores hosted chunks when the frozen route is local or disabled", async () => {
		const updates: unknown[] = []
		const local = resolveWebSearchRoutingPlan({
			enabled: true,
			modelInfo: undefined,
			selectedApiFormat: ApiFormat.OPENAI_CHAT,
			localAvailable: true,
			remoteAdapterAvailable: false,
		})
		const lifecycle = new ServerToolLifecycle(local, true, (update) => {
			updates.push(update)
		})

		expect(await lifecycle.consume(chunk("started"))).toBe(false)
		expect(updates).toEqual([])
	})

	it("admits hosted Web Fetch by its own route while Web Search stays local", async () => {
		const fetchOnly = resolveWebSearchRoutingPlan({
			enabled: true,
			modelInfo: { capabilities: { tools: [ServerTool.WEB_FETCH] } },
			selectedApiFormat: ApiFormat.ANTHROPIC_CHAT,
			localAvailable: true,
			remoteAdapterAvailable: true,
			remoteWebFetchAdapterAvailable: true,
		})
		expect(fetchOnly.route).toBe("local")
		expect(fetchOnly.webFetchRoute).toBe("hosted")
		const updates: Array<{ tool: ServerTool; status: string; query: string }> = []
		const lifecycle = new ServerToolLifecycle(fetchOnly, true, (update) => {
			updates.push({ tool: update.tool, status: update.status, query: update.query })
		})

		const fetchChunk = { ...chunk("started", { url: "https://example.com/page" }), tool: ServerTool.WEB_FETCH }
		expect(await lifecycle.consume(fetchChunk)).toBe(true)
		expect(await lifecycle.consume({ ...chunk("started"), dline_tid: "trace-2", function_id: "provider-call-2" })).toBe(false)

		expect(updates).toEqual([{ tool: ServerTool.WEB_FETCH, status: "started", query: "https://example.com/page" }])
	})

	it("drops hosted Web Fetch chunks when only Web Search is hosted", async () => {
		const searchOnly = resolveWebSearchRoutingPlan({
			enabled: true,
			modelInfo: { capabilities: { tools: [ServerTool.WEB_SEARCH] } },
			selectedApiFormat: ApiFormat.ANTHROPIC_CHAT,
			localAvailable: true,
			remoteAdapterAvailable: true,
			remoteWebFetchAdapterAvailable: true,
		})
		expect(searchOnly.route).toBe("hosted")
		expect(searchOnly.webFetchRoute).toBe("local")
		const updates: unknown[] = []
		const lifecycle = new ServerToolLifecycle(searchOnly, true, (update) => {
			updates.push(update)
		})

		expect(await lifecycle.consume({ ...chunk("started"), tool: ServerTool.WEB_FETCH })).toBe(false)
		expect(updates).toEqual([])
	})
})
