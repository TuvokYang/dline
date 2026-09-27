import { openAiCodexModels } from "@core/api/providers/models/openai-codex"
import { mockFetchForTesting } from "@shared/net"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { OpenAiCodexProviderConfig } from "@shared/proto/dline/provider/openai_codex"
import { resolveProfileModelInfo } from "@shared/providers/profile-model-info"
import { expect } from "chai"
import type { ChatCompletionTool } from "openai/resources/chat/completions"
import { afterEach, describe, it, vi } from "vitest"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { OutputLimitExceededError } from "../../stream/OutputLimitExceededError"
import { OpenAiCodexHandler } from "../openai-codex"

const localTools: ChatCompletionTool[] = [
	{
		type: "function",
		function: { name: "web_search", description: "Local search", parameters: { type: "object" } },
	},
	{
		type: "function",
		function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
	},
]

function createHandler(): OpenAiCodexHandler {
	return new OpenAiCodexHandler({
		profile: ApiProfile.create({ id: "profile-a", provider: "openai-codex", modelId: "gpt-5.6-sol" }),
		mode: "act",
		workspaceId: "workspace-a",
		ulid: "task-a",
	})
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
	const chunks: unknown[] = []
	for await (const chunk of stream) chunks.push(chunk)
	return chunks
}

async function* eventStream(events: readonly unknown[]): AsyncGenerator<unknown> {
	for (const event of events) yield event
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe("OpenAiCodexHandler hosted Web Search", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("declares hosted Web Search support for Responses models", () => {
		const handler = createHandler()

		expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).to.equal(true)
		expect(handler.supportsServerTool(ServerTool.SERVER_TOOL_UNSPECIFIED)).to.equal(false)
	})

	it("projects hosted Web Search through the public request boundary", async () => {
		const handler = createHandler()
		vi.spyOn(openAiCodexOAuthManager, "getCredentialContext").mockResolvedValue({
			accessToken: "access-token",
			expires: 1_900_000_000_000,
			accountId: "account-a",
		})
		let requestBody: Record<string, unknown> | undefined
		let fallbackRequestBody: Record<string, unknown> | undefined
		vi.spyOn(handler as any, "executeRequest").mockImplementation(async function* (...args: unknown[]) {
			requestBody = args[0] as Record<string, unknown>
			fallbackRequestBody = args[1] as Record<string, unknown>
		})

		await collect(
			handler.createMessage("system prompt", [{ role: "user", content: "Search" }], localTools, {
				serverTools: [ServerTool.WEB_SEARCH],
			}),
		)

		expect(requestBody?.tools).to.deep.equal([
			{ type: "function", name: "read_file", description: "Read a file", parameters: { type: "object" }, strict: true },
			{ type: "web_search" },
		])
		expect(requestBody?.include).to.deep.equal([
			"reasoning.encrypted_content",
			"web_search_call.results",
			"web_search_call.action.sources",
		])
		expect(fallbackRequestBody?.tools).to.deep.equal(requestBody?.tools)
		expect(fallbackRequestBody?.include).to.deep.equal(requestBody?.include)
	})

	it("uses stable workspace and task identity for every Codex transport", () => {
		const handler = createHandler()
		const headers = (handler as any).buildCodexHeaders({
			accessToken: "access-token",
			expires: 1_900_000_000_000,
			accountId: "account-a",
		}) as Record<string, string>

		expect(headers).to.deep.include({
			"session-id": "workspace-a",
			"thread-id": "task-a",
			"x-client-request-id": "task-a",
			"ChatGPT-Account-Id": "account-a",
		})
		expect(headers).not.to.have.property("session_id")
		expect(headers).not.to.have.property("conversation_id")
	})

	it("projects one automatic prompt cache key without explicit cache controls", () => {
		const handler = createHandler()
		const model = handler.getModel()
		const first = (handler as any).buildRequestBody(model, [], "stable system", localTools, undefined, {
			taskNamespace: "task-a",
		}) as Record<string, unknown>
		const appended = (handler as any).buildRequestBody(
			model,
			[{ role: "user", content: [] }],
			"stable system",
			localTools,
			undefined,
			{
				taskNamespace: "task-a",
			},
		) as Record<string, unknown>
		const otherTask = (handler as any).buildRequestBody(model, [], "stable system", localTools, undefined, {
			taskNamespace: "task-b",
		}) as Record<string, unknown>

		expect(first.prompt_cache_key).to.match(/^dline_cache_[0-9a-f]{32}$/)
		expect(appended.prompt_cache_key).to.equal(first.prompt_cache_key)
		expect(otherTask.prompt_cache_key).not.to.equal(first.prompt_cache_key)
		expect(first.prompt_cache_options).to.equal(undefined)
		expect(JSON.stringify(first)).not.to.contain("prompt_cache_breakpoint")
	})

	it("keeps the ordinary Responses cache envelope unchanged for a compaction request", () => {
		const handler = createHandler()
		const model = handler.getModel()
		const formattedInput = [
			{ type: "message", role: "user", content: [{ type: "input_text", text: "oldest cached turn" }] },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "cached answer" }] },
		]
		const ordinary = (handler as any).buildRequestBody(model, formattedInput, "stable system", localTools, undefined, {
			taskNamespace: "task-a",
		}) as Record<string, unknown>
		const compaction = (handler as any).buildRequestBody(model, formattedInput, "stable system", localTools, undefined, {
			taskNamespace: "task-a",
			generation: { purpose: "compaction", maxOutputTokens: 30_000 },
		}) as Record<string, unknown>

		expect(compaction.prompt_cache_key).to.equal(ordinary.prompt_cache_key)
		expect(compaction.instructions).to.deep.equal(ordinary.instructions)
		expect(compaction.tools).to.deep.equal(ordinary.tools)
		expect(compaction.input).to.deep.equal(ordinary.input)
	})

	it("isolates previous_response_id as the only primary/fallback body difference", () => {
		const handler = createHandler()
		const model = handler.getModel()
		const input = [{ type: "message", role: "user", content: [] }]
		const primary = (handler as any).buildRequestBody(model, input, "stable system", localTools, "response-a", {
			taskNamespace: "task-a",
		}) as Record<string, unknown>
		const fallback = (handler as any).buildRequestBody(model, input, "stable system", localTools, undefined, {
			taskNamespace: "task-a",
		}) as Record<string, unknown>
		const { previous_response_id: previousResponseId, ...primaryWithoutPreviousResponse } = primary

		expect(previousResponseId).to.equal("response-a")
		expect(primaryWithoutPreviousResponse).to.deep.equal(fallback)
	})

	it("uses Profile model limits and the selected Responses transport at runtime", () => {
		const configuredProfile = ApiProfile.create({
			id: "profile-websocket",
			provider: "openai-codex",
			modelId: "gpt-6-astra",
			openaiCodex: OpenAiCodexProviderConfig.create({
				apiFormat: ApiFormat.OPENAI_RESPONSES,
				websocketEnabled: true,
				capabilities: { contextWindow: 400_000, maxTokens: 64_000 },
			}),
		})
		const profile = ApiProfile.create({
			...configuredProfile,
			modelInfo: resolveProfileModelInfo(configuredProfile, {
				models: openAiCodexModels,
				defaultModelId: "gpt-6-astra",
			}),
		})
		const handler = new OpenAiCodexHandler({ profile, mode: "act" })
		const model = handler.getModel()

		expect(model.info.capabilities?.contextWindow).to.equal(400_000)
		expect(model.info.capabilities?.maxTokens).to.equal(64_000)
		expect(model.info.apiFormats?.[0]).to.equal(ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE)
		expect((handler as any).shouldUseWebsocketMode(model.info.apiFormats?.[0])).to.equal(true)
	})

	it("keeps a remotely discovered Codex model id instead of falling back to the bundled default", () => {
		const handler = new OpenAiCodexHandler({
			profile: ApiProfile.create({ id: "profile-remote", provider: "openai-codex", modelId: "gpt-codex-remote" }),
			mode: "act",
			workspaceId: "workspace-a",
			ulid: "task-a",
		})

		expect(handler.getModel()).to.deep.include({ id: "gpt-codex-remote" })
		expect(handler.getModel().info).to.deep.include({ id: "gpt-codex-remote" })
		expect(handler.getModel().info.capabilities?.supportsPromptCache).to.equal(true)
	})

	it("omits the unsupported request-scoped compaction cap from primary and fallback Responses bodies", () => {
		const handler = createHandler()
		const options = { generation: { purpose: "compaction", maxOutputTokens: 30_000 } } as any
		const body = (handler as any).buildRequestBody(
			handler.getModel(),
			[],
			"system",
			undefined,
			"response-id",
			options,
		) as Record<string, unknown>
		const fallback = (handler as any).buildRequestBody(
			handler.getModel(),
			[],
			"system",
			undefined,
			undefined,
			options,
		) as Record<string, unknown>

		expect(body).not.to.have.property("max_output_tokens")
		expect(fallback).not.to.have.property("max_output_tokens")
	})

	it("projects hosted Web Search when no local functions are present", () => {
		const handler = createHandler()
		const body = (handler as any).buildRequestBody(handler.getModel(), [], "system", undefined, undefined, {
			serverTools: [ServerTool.WEB_SEARCH],
		}) as Record<string, unknown>

		expect(body.tools).to.deep.equal([{ type: "web_search" }])
	})

	it("keeps local Web Search when the hosted route was not selected", () => {
		const handler = createHandler()
		const body = (handler as any).buildRequestBody(handler.getModel(), [], "system", localTools) as {
			tools: Array<{ type: string; name?: string }>
		}

		expect(body.tools.filter((tool) => tool.type === "web_search")).to.have.length(0)
		expect(body.tools.filter((tool) => tool.name === "web_search")).to.have.length(1)
	})

	it("normalizes hosted lifecycle events from Codex Responses", async () => {
		const handler = createHandler()
		const events = [
			{
				type: "response.output_item.added",
				item: { type: "web_search_call", id: "ws_1", action: { query: "Dline" } },
			},
			{ type: "response.web_search_call.in_progress", item_id: "ws_1" },
			{ type: "response.web_search_call.searching", item_id: "ws_1" },
			{ type: "response.web_search_call.completed", item_id: "ws_1" },
			{
				type: "response.output_item.done",
				item: {
					type: "web_search_call",
					id: "ws_1",
					status: "completed",
					action: { query: "Dline" },
					results: [{ title: "Dline result", url: "https://example.com/dline" }],
				},
			},
		]
		const chunks = await collect((handler as any).handleResponseEvents(eventStream(events), handler.getModel()))

		expect(chunks.filter((chunk: any) => chunk.type === "server_tool")).to.deep.include.members([
			{
				type: "server_tool",
				function_id: "ws_1",
				provider_metadata: { item_id: "ws_1" },
				tool: ServerTool.WEB_SEARCH,
				phase: "started",
				input: { query: "Dline" },
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
				result: {
					action: { query: "Dline" },
					results: [{ title: "Dline result", url: "https://example.com/dline" }],
				},
			},
		])
	})

	it("uses shared Responses stitching without duplicating snapshots and preserves replay metadata", async () => {
		const handler = createHandler()
		const completeArguments = JSON.stringify({ path: "README.md" })
		const splitAt = Math.floor(completeArguments.length / 2)
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				sequence_number: 1,
				item: { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "partial-reasoning" },
			},
			{ type: "response.reasoning.delta", delta: "thinking", output_index: 0, sequence_number: 2 },
			{
				type: "response.output_item.done",
				output_index: 0,
				sequence_number: 3,
				item: { type: "reasoning", id: "rs_1", text: "thinking", encrypted_content: "final-reasoning" },
			},
			{
				type: "response.output_item.added",
				output_index: 1,
				sequence_number: 4,
				item: { type: "message", id: "msg_1", role: "assistant", content: [] },
			},
			{ type: "response.text.delta", delta: "hello", output_index: 1, sequence_number: 5 },
			{
				type: "response.output_item.done",
				output_index: 1,
				sequence_number: 6,
				item: {
					type: "message",
					id: "msg_1",
					role: "assistant",
					content: [{ type: "output_text", text: "hello" }],
				},
			},
			{
				type: "response.output_item.added",
				output_index: 2,
				sequence_number: 7,
				item: { type: "tool_call", id: "fc_1", tool_call_id: "call_1", name: "read_file", arguments: "" },
			},
			{
				type: "response.tool_call_arguments.delta",
				item_id: "fc_1",
				tool_call_id: "call_1",
				function_name: "read_file",
				delta: completeArguments.slice(0, splitAt),
				output_index: 2,
				sequence_number: 8,
			},
			{
				type: "response.tool_call_arguments.delta",
				item_id: "fc_1",
				tool_call_id: "call_1",
				function_name: "read_file",
				delta: completeArguments.slice(splitAt),
				output_index: 2,
				sequence_number: 9,
			},
			{
				type: "response.tool_call_arguments.done",
				item_id: "fc_1",
				tool_call_id: "call_1",
				function_name: "read_file",
				arguments: completeArguments,
				output_index: 2,
				sequence_number: 10,
			},
			{
				type: "response.output_item.done",
				output_index: 2,
				sequence_number: 11,
				item: {
					type: "tool_call",
					id: "fc_1",
					tool_call_id: "call_1",
					name: "read_file",
					arguments: completeArguments,
				},
			},
			{
				type: "response.done",
				response: {
					id: "resp_1",
					usage: {
						input_tokens: 100,
						input_tokens_details: { cached_tokens: 80 },
						output_tokens: 10,
						output_tokens_details: { reasoning_tokens: 5 },
						total_tokens: 110,
					},
				},
			},
		]

		const chunks = (await collect((handler as any).handleResponseEvents(eventStream(events), handler.getModel()))) as any[]

		expect(chunks.filter((chunk) => chunk.type === "text").map((chunk) => chunk.text)).to.deep.equal(["hello"])
		expect(
			chunks
				.filter((chunk) => chunk.type === "tool_calls" && chunk.tool_call.function.arguments !== undefined)
				.map((chunk) => chunk.tool_call.function.arguments),
		).to.deep.equal([completeArguments.slice(0, splitAt), completeArguments.slice(splitAt)])
		expect(chunks.filter((chunk) => chunk.type === "tool_calls" && chunk.phase === "completed")).to.have.length(1)
		expect(chunks).to.deep.include({
			type: "reasoning",
			provider_metadata: { response_id: "rs_1" },
			reasoning: "thinking",
		})
		expect(chunks).to.deep.include({
			type: "reasoning",
			provider_metadata: { response_id: "rs_1" },
			reasoning: "",
			redacted_data: "final-reasoning",
			redacted_phase: "final",
		})
		expect(chunks).to.deep.include({
			type: "usage",
			inputTokens: 20,
			outputTokens: 10,
			cacheWriteTokens: 0,
			cacheReadTokens: 80,
			thoughtsTokenCount: 5,
			totalCost: 0,
			provider_metadata: { response_id: "resp_1" },
		})
	})

	it("surfaces Codex max_output_tokens as typed termination without HTTP fallback", async () => {
		const handler = createHandler()
		const responseStream = {
			async *[Symbol.asyncIterator]() {
				yield {
					type: "response.incomplete",
					response: { status: "incomplete", incomplete_details: { reason: "max_output_tokens" } },
				}
			},
		}
		;(handler as any).client = { responses: { create: vi.fn().mockResolvedValue(responseStream) } }
		const fallback = vi.spyOn(handler as any, "makeCodexRequest").mockImplementation(async function* () {
			yield { type: "text", text: "unexpected fallback" }
		})

		let caught: unknown
		try {
			await collect(
				(handler as any).executeRequest(
					{},
					{},
					handler.getModel(),
					{ accessToken: "access-token", expires: 1_900_000_000_000 },
					false,
				),
			)
		} catch (error) {
			caught = error
		}

		expect(caught).to.be.instanceOf(OutputLimitExceededError)
		expect(caught).to.deep.include({ protocol: "openai_responses", reason: "max_output_tokens" })
		expect(fallback.mock.calls).to.have.length(0)
	})

	it("maps a failed output item to one failed hosted lifecycle event", async () => {
		const handler = createHandler()
		const chunks = await collect(
			(handler as any).handleResponseEvents(
				eventStream([
					{
						type: "response.output_item.done",
						item: { type: "web_search_call", id: "ws_failed", status: "failed", action: { code: "search_failed" } },
					},
				]),
				handler.getModel(),
			),
		)

		expect(chunks).to.deep.equal([
			{
				type: "server_tool",
				function_id: "ws_failed",
				provider_metadata: { item_id: "ws_failed" },
				tool: ServerTool.WEB_SEARCH,
				phase: "failed",
				error: { code: "search_failed" },
			},
		])
	})

	it("cancels the HTTP response body when the consumer stops early", async () => {
		const handler = createHandler()
		const cancelBody = vi.fn()
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"hello"}\n\n'))
			},
			cancel: cancelBody,
		})

		for await (const _chunk of (handler as any).handleStreamResponse(body, handler.getModel())) break

		expect(cancelBody.mock.calls).to.have.length(1)
		expect(cancelBody.mock.calls[0]?.[0]).to.equal(undefined)
	})

	it("rejects a Codex handler without a stable Profile ID", () => {
		expect(
			() =>
				new OpenAiCodexHandler({
					profile: ApiProfile.create({ provider: "openai-codex", modelId: "gpt-5.6-sol" }),
					mode: "act",
				}),
		).to.throw("Profile ID")
	})

	it("passes one atomic credential context through the request transport", async () => {
		const handler = createHandler()
		const credential = { accessToken: "access-a", expires: 1_900_000_000_000, accountId: "account-a" }
		const getCredential = vi.spyOn(openAiCodexOAuthManager, "getCredentialContext").mockResolvedValue(credential)
		const execute = vi.spyOn(handler as any, "executeRequest").mockImplementation(async function* () {})

		await collect(handler.createMessage("system", [{ role: "user", content: "hello" }]))

		expect(getCredential.mock.calls).to.deep.equal([["profile-a"]])
		expect(execute.mock.calls[0]?.[3]).to.equal(credential)
	})

	it("replaces token and account ID together when retrying a 401", async () => {
		const handler = createHandler()
		const first = { accessToken: "access-a", expires: 1_900_000_000_000, accountId: "account-a" }
		const refreshed = { accessToken: "access-b", expires: 1_900_000_100_000, accountId: "account-b" }
		vi.spyOn(openAiCodexOAuthManager, "getCredentialContext").mockResolvedValue(first)
		const refresh = vi.spyOn(openAiCodexOAuthManager, "forceRefreshCredentialContext").mockResolvedValue(refreshed)
		const contexts: unknown[] = []
		vi.spyOn(handler as any, "executeRequest").mockImplementation(async function* (...args: unknown[]) {
			contexts.push(args[3])
			if (contexts.length === 1) throw Object.assign(new Error("request rejected"), { status: 401 })
		})

		await collect(handler.createMessage("system", [{ role: "user", content: "hello" }]))

		expect(refresh.mock.calls).to.deep.equal([["profile-a"]])
		expect(contexts).to.deep.equal([first, refreshed])
	})

	it("uses matching token and account ID snapshots for usage before and after a 401", async () => {
		const handler = createHandler()
		const first = { accessToken: "access-a", expires: 1_900_000_000_000, accountId: "account-a" }
		const refreshed = { accessToken: "access-b", expires: 1_900_000_100_000, accountId: "account-b" }
		let current = first
		vi.spyOn(openAiCodexOAuthManager, "getCredentialContext").mockImplementation(async () => current)
		vi.spyOn(openAiCodexOAuthManager, "forceRefreshCredentialContext").mockImplementation(async () => {
			current = refreshed
			return refreshed
		})
		const headers: Array<{ authorization: string | null; accountId: string | null }> = []
		const transport = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			const requestHeaders = new Headers(init?.headers)
			headers.push({
				authorization: requestHeaders.get("Authorization"),
				accountId: requestHeaders.get("ChatGPT-Account-Id"),
			})
			if (headers.length === 1) return new Response(undefined, { status: 401 })
			const payload =
				headers.length === 2
					? {
							plan_type: "pro",
							rate_limit: {
								allowed: true,
								limit_reached: false,
								primary_window: {
									used_percent: 25,
									limit_window_seconds: 18_000,
									reset_at: 1_900_000_000,
								},
							},
							credits: { balance: "9" },
							rate_limit_reset_credits: { available_count: 1 },
						}
					: {
							total_count: 1,
							credits: [{ id: "credit-a", expires_at: "2030-03-25T00:00:00.000Z" }],
						}
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})
		})

		const usage = await mockFetchForTesting(transport, () => handler.getAccountUsage())

		expect(usage).to.deep.include({
			remainingBalance: 9,
			planType: "pro",
			allowed: true,
			limitReached: false,
			resetCreditsAvailableCount: 1,
		})
		expect(usage?.quotas).to.deep.equal([
			{
				type: "5hour",
				label: "5 hour",
				shortLabel: "5h",
				used: 25,
				limit: 100,
				windowSeconds: 18_000,
				resetAt: new Date(1_900_000_000_000).toISOString(),
			},
		])
		expect(usage?.resetCredits).to.deep.equal([{ id: "credit-a", expiresAt: "2030-03-25T00:00:00.000Z" }])
		expect(headers).to.deep.equal([
			{ authorization: "Bearer access-a", accountId: "account-a" },
			{ authorization: "Bearer access-b", accountId: "account-b" },
			{ authorization: "Bearer access-b", accountId: "account-b" },
		])
	})

	it("consumes a reset credit through the provider-neutral handler capability", async () => {
		const handler = createHandler()
		vi.spyOn(openAiCodexOAuthManager, "getCredentialContext").mockResolvedValue({
			accessToken: "access-a",
			expires: 1_900_000_000_000,
			accountId: "account-a",
		})
		let requestBody: Record<string, unknown> | undefined
		const transport = vi.fn<typeof globalThis.fetch>(async (_input, init) => {
			requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
			return new Response(JSON.stringify({ result: "reset", windows_reset: ["primary"] }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})
		})

		const result = await mockFetchForTesting(transport, () => handler.consumeAccountUsageResetCredit("credit-a"))

		expect(result).to.deep.equal({ outcome: "reset", quotaTypesReset: ["primary"] })
		expect(requestBody).to.deep.include({ credit_id: "credit-a" })
		expect(requestBody?.redeem_request_id).to.be.a("string").and.not.equal("")
	})

	it("aborts only when the active handler receives a mutation for its own Profile", async () => {
		const handler = createHandler()
		const gate = deferred<void>()
		const started = deferred<void>()
		vi.spyOn(openAiCodexOAuthManager, "getCredentialContext").mockResolvedValue({
			accessToken: "access-a",
			expires: 1_900_000_000_000,
			accountId: "account-a",
		})
		vi.spyOn(handler as any, "executeRequest").mockImplementation(async function* () {
			started.resolve()
			await gate.promise
		})
		const abort = vi.spyOn(handler, "abort")
		const request = collect(handler.createMessage("system", [{ role: "user", content: "hello" }]))
		await started.promise

		await (openAiCodexOAuthManager as any).publishRuntimeMutation("profile-b", "credential-cleared")
		expect(abort.mock.calls).to.have.length(0)
		await (openAiCodexOAuthManager as any).publishRuntimeMutation("profile-a", "credential-cleared")
		expect(abort.mock.calls).to.have.length(1)

		gate.resolve()
		await request
	})

	it("matches WebSocket reuse against both token and account ID", () => {
		const handler = createHandler()
		const first = { accessToken: "access-a", expires: 1_900_000_000_000, accountId: "account-a" }

		expect((handler as any).isSameCredentialContext(first, { ...first })).to.equal(true)
		expect((handler as any).isSameCredentialContext(first, { ...first, accessToken: "access-b" })).to.equal(false)
		expect((handler as any).isSameCredentialContext(first, { ...first, accountId: "account-b" })).to.equal(false)
	})

	it("does not expose raw provider errors from the request boundary", async () => {
		const handler = createHandler()
		const secret = "access_token=secret-token&account_payload=secret-account"
		vi.spyOn(openAiCodexOAuthManager, "getCredentialContext").mockResolvedValue({
			accessToken: "access-a",
			expires: 1_900_000_000_000,
			accountId: "account-a",
		})
		vi.spyOn(handler as any, "executeRequest").mockImplementation(async function* () {
			throw Object.assign(new Error(secret), { status: 500, code: "provider_failure" })
		})

		const error = await collect(handler.createMessage("system", [{ role: "user", content: "hello" }])).catch(
			(caught: unknown) => caught,
		)

		expect(String(error)).not.to.contain(secret)
		expect(error).to.deep.include({ status: 500, code: "provider_failure" })
	})

	it("sends hosted Web Search over WebSocket without the HTTP-only stream field", async () => {
		const handler = createHandler()
		const listeners = new Map<string, Set<(event: any) => void>>()
		let sent: Record<string, unknown> | undefined
		const socket = {
			addEventListener(type: string, listener: (event: any) => void) {
				const entries = listeners.get(type) ?? new Set()
				entries.add(listener)
				listeners.set(type, entries)
			},
			removeEventListener(type: string, listener: (event: any) => void) {
				listeners.get(type)?.delete(listener)
			},
			send(payload: string) {
				sent = JSON.parse(payload) as Record<string, unknown>
				queueMicrotask(() => {
					for (const listener of listeners.get("message") ?? []) {
						listener({ data: JSON.stringify({ type: "response.completed", response: {} }) })
					}
				})
			},
		}
		vi.spyOn(handler as any, "ensureResponsesWebsocket").mockResolvedValue(socket)

		await collect(
			(handler as any).createResponseEventsViaWebsocket(
				{ model: "gpt-5.6-sol", input: [], stream: true, tools: [{ type: "web_search" }] },
				{ accessToken: "access-token", expires: 1_900_000_000_000 },
				{},
			),
		)

		expect(sent).to.deep.include({ type: "response.create", model: "gpt-5.6-sol" })
		expect(sent?.tools).to.deep.equal([{ type: "web_search" }])
		expect(sent).not.to.have.property("stream")
	})
})
