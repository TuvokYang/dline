import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile, ImageGenerationSource } from "@shared/proto/dline/profile"
import { OpenAiPromptCacheMode, OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { OpenAiCodexProviderConfig } from "@shared/proto/dline/provider/openai_codex"
import {
	bindProviderAttemptScope,
	type ProviderAttemptObserver,
	type ProviderAttemptTerminalStatus,
} from "@shared/provider-attempt-observer"
import { expect } from "chai"
import OpenAI from "openai"
import should from "should"
import { afterEach, describe, it, vi } from "vitest"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import type { ClineAssistantToolUseBlock, ClineStorageMessage, ClineUserToolResultContentBlock } from "@/shared/messages/content"
import { mockFetchForTesting, providerFetch } from "@/shared/net"
import { OutputLimitExceededError } from "../../stream/OutputLimitExceededError"
import { StreamIdleTimeoutError } from "../../stream/openai-responses-stream-monitor"
import { OpenAiHandler } from "../openai"
import { OpenAiCodexHandler } from "../openai-codex"

/**
 * Create an async iterable for mocked streaming responses.
 *
 * @param data Stream chunks to yield.
 * @returns Async iterable yielding provided chunks.
 */
const createAsyncIterable = (data: readonly unknown[] = []) => ({
	[Symbol.asyncIterator]: async function* () {
		yield* data
	},
})

function createProviderAttemptObserver() {
	const statuses: ProviderAttemptTerminalStatus[] = []
	let nextHandle = 0
	const observer: ProviderAttemptObserver<number> = {
		beginAttempt: () => nextHandle++,
		finishAttempt: (_handle, status) => {
			statuses.push(status)
		},
	}
	return { observer, statuses }
}

function createTransportBackedResponsesCreate() {
	return vi.fn(async (_params: OpenAI.Responses.ResponseCreateParamsStreaming, _options?: { signal?: AbortSignal }) => {
		const response = await providerFetch("https://compatible.example/v1/responses", { method: "POST" })
		const body = await response.text()
		if (!response.ok) throw Object.assign(new Error(body), { status: response.status })
		return createAsyncIterable()
	})
}

describe("OpenAiHandler", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("getModel", () => {
		it("should build model info from provider capability and pricing overrides", () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "custom-openai-compatible-model",
					openai: OpenAiProviderConfig.create({
						capabilities: {
							maxTokens: 12_345,
							supportsPromptCache: true,
							temperature: 0.7,
						},
						pricing: {
							inputPrice: 0.5,
							outputPrice: 1.5,
						},
					}),
				}),
				mode: "act",
			})

			const result = handler.getModel()

			result.id.should.equal("custom-openai-compatible-model")
			result.info.id.should.equal("custom-openai-compatible-model")
			should(result.info.capabilities?.maxTokens).equal(12_345)
			should(result.info.capabilities?.supportsPromptCache).equal(true)
			should(result.info.capabilities?.temperature).equal(0.7)
			should(result.info.pricing?.inputPrice).equal(0.5)
		})

		it("reports hosted web search unavailable for the Chat transport", () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					modelId: "chat-only-model",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})

			expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).to.equal(false)
		})
	})

	describe("createMessage", () => {
		it("disables SDK retries so Dline owns the retry policy", () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "custom-openai-compatible-model",
				}),
				mode: "act",
			})

			const client = (handler as unknown as { ensureClient: () => OpenAI }).ensureClient()

			expect(client.maxRetries).to.equal(0)
		})

		it("disables Azure SDK retries so Dline owns the retry policy", () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					baseUrl: "https://dline-e2e.openai.azure.com/openai",
					modelId: "azure-model",
					openai: OpenAiProviderConfig.create({ azureApiVersion: "2025-04-01-preview" }),
				}),
				mode: "act",
			})

			const client = (handler as unknown as { ensureClient: () => OpenAI }).ensureClient()

			expect(client.maxRetries).to.equal(0)
		})

		it("should use provider capabilities for request max tokens and temperature", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "custom-openai-compatible-model",
					openai: OpenAiProviderConfig.create({
						capabilities: {
							maxTokens: 12_345,
							temperature: 0.7,
						},
					}),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(createAsyncIterable())

			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: {
					completions: {
						create,
					},
				},
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = create.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			should(requestBody?.max_tokens).equal(12_345)
			should(requestBody?.temperature).equal(0.7)
		})

		it("uses the request-scoped compaction cap for Chat completions", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "custom-openai-compatible-model",
					openai: OpenAiProviderConfig.create({ capabilities: { maxTokens: 12_345 } }),
				}),
				mode: "act",
				workspaceId: "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				ulid: "task-compaction",
			})
			const create = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }], undefined, {
				generation: { purpose: "compaction", maxOutputTokens: 30_000 },
			} as any)) {
			}

			const requestBody = create.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			const requestOptions = create.mock.calls[0]?.[1] as { headers?: Record<string, string> }
			expect(requestBody?.max_tokens).to.equal(30_000)
			expect(requestOptions.headers).to.deep.equal({
				"session-id": "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"thread-id": "task-compaction",
				"x-client-request-id": "task-compaction",
			})
		})

		it("emits a completed tool-call boundary only for compaction Chat requests", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "custom-openai-compatible-model",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(
				createAsyncIterable([
					{
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_summary",
											type: "function",
											function: { name: "summarize_task", arguments: '{"context":"Completed summary"}' },
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]),
			)
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			const chunks = []
			for await (const chunk of handler.createMessage(
				"system prompt",
				[{ role: "user", content: "Summarize" }],
				undefined,
				{
					generation: { purpose: "compaction", maxOutputTokens: 30_000 },
				},
			)) {
				chunks.push(chunk)
			}

			expect(chunks).to.have.length(2)
			expect(chunks[0]).to.deep.include({ function_id: "call_summary", tool_index: 0 })
			expect(chunks[1]).to.deep.include({ function_id: "call_summary", phase: "completed", tool_index: 0 })
		})

		it("does not add a completion chunk to ordinary Chat tool calls", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "custom-openai-compatible-model",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(
				createAsyncIterable([
					{
						choices: [
							{
								index: 0,
								delta: {
									tool_calls: [
										{
											index: 0,
											id: "call_qna",
											type: "function",
											function: { name: "qna_respond", arguments: '{"response":"Continue"}' },
										},
									],
								},
								finish_reason: null,
							},
						],
					},
					{ choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
				]),
			)
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			const chunks = []
			for await (const chunk of handler.createMessage("system prompt", [{ role: "user", content: "Continue" }])) {
				chunks.push(chunk)
			}

			expect(chunks).to.have.length(1)
			expect(chunks[0]).to.deep.include({ function_id: "call_qna", tool_index: 0 })
			expect(chunks[0]).not.to.have.property("phase")
		})

		it("throws a typed output-limit error for Chat finish_reason length", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "custom-openai-compatible-model",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})
			const create = vi
				.fn()
				.mockResolvedValue(createAsyncIterable([{ choices: [{ delta: {}, finish_reason: "length", index: 0 }] }]))
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			let caught: unknown
			try {
				for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
				}
			} catch (error) {
				caught = error
			}

			expect(caught).to.be.instanceOf(OutputLimitExceededError)
			expect(caught).to.deep.include({ protocol: "openai_chat", reason: "length" })
		})

		it("passes explicitly enabled service tier and ultra effort to an OpenAI-compatible endpoint", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-5.6-compatible",
					openai: OpenAiProviderConfig.create({
						serviceTier: "priority",
						serviceTierEnabled: true,
						reasoning: { enableThinking: true, effort: "ultra" },
					}),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = create.mock.calls[0]?.[0] as Record<string, unknown>
			expect(requestBody.service_tier).to.equal("priority")
			expect(requestBody.reasoning_effort).to.equal("ultra")
			expect(requestBody.prompt_cache_key).to.be.a("string").and.not.equal("")
			expect(requestBody.prompt_cache_options).to.equal(undefined)
			expect(JSON.stringify(requestBody.messages)).not.to.contain("prompt_cache_breakpoint")
		})

		it("suppresses a configured service tier unless the Profile explicitly enables Service Tier", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-5.6-compatible",
					openai: OpenAiProviderConfig.create({ serviceTier: "priority" }),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = create.mock.calls[0]?.[0] as Record<string, unknown>
			expect(requestBody).not.to.have.property("service_tier")
		})

		it("adds a stable Chat cache key while suppressing explicit controls across dynamic suffixes", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-5.6-sol",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			for await (const _chunk of handler.createMessage("frozen system prompt", [
				{ role: "user", content: "dynamic environment A" },
			])) {
			}
			for await (const _chunk of handler.createMessage("frozen system prompt", [
				{ role: "user", content: "dynamic environment B" },
			])) {
			}

			const firstRequest = create.mock.calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
			const secondRequest = create.mock.calls[1]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
			expect(firstRequest.prompt_cache_key).to.be.a("string").and.not.equal("")
			expect(secondRequest.prompt_cache_key).to.equal(firstRequest.prompt_cache_key)
			expect(firstRequest.prompt_cache_options).to.equal(undefined)
			expect(JSON.stringify(firstRequest.messages)).not.to.contain("prompt_cache_breakpoint")
			expect(JSON.stringify(firstRequest.messages.at(-1))).to.contain("dynamic environment A")
			expect(JSON.stringify(secondRequest.messages.at(-1))).to.contain("dynamic environment B")
		})

		it("keeps the complete prior Chat request as an exact prefix when another turn is appended", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					baseUrl: "https://compatible.example/v1",
					modelId: "gpt-5.6-sol",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			const firstHistory: ClineStorageMessage[] = [
				{ role: "user", content: "first user turn" },
				{ role: "assistant", content: "first assistant turn" },
				{ role: "user", content: "second user turn" },
			]
			const secondHistory: ClineStorageMessage[] = [
				...firstHistory,
				{ role: "assistant", content: "second assistant turn" },
				{ role: "user", content: "third user turn" },
			]

			for await (const _chunk of handler.createMessage("frozen system prompt", firstHistory)) {
			}
			for await (const _chunk of handler.createMessage("frozen system prompt", secondHistory)) {
			}

			const firstRequest = create.mock.calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
			const secondRequest = create.mock.calls[1]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
			expect(JSON.stringify(firstRequest.messages)).not.to.contain("cache_control")
			expect(JSON.stringify(secondRequest.messages)).not.to.contain("cache_control")
			expect(secondRequest.prompt_cache_key).to.equal(firstRequest.prompt_cache_key)
			expect(secondRequest.messages.slice(0, firstRequest.messages.length)).to.deep.equal(firstRequest.messages)
		})

		it("retries Chat once with automatic caching when an opted-in endpoint rejects explicit controls", async () => {
			const config = OpenAiProviderConfig.create({
				apiFormat: ApiFormat.OPENAI_CHAT,
				promptCacheMode: OpenAiPromptCacheMode.OPENAI_PROMPT_CACHE_MODE_EXPLICIT,
			})
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					baseUrl: "https://compatible.example/v1",
					modelId: "gpt-5.6-sol",
					openai: config,
				}),
				mode: "act",
				workspaceId: "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				ulid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			})
			const protocolError = Object.assign(new Error("prompt_cache_breakpoint is not supported on this model"), {
				status: 400,
			})
			const create = vi.fn().mockRejectedValueOnce(protocolError).mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			expect(create.mock.calls).to.have.length(2)
			const explicitRequest = create.mock.calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
			const fallbackRequest = create.mock.calls[1]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
			const explicitOptions = create.mock.calls[0]?.[1] as { headers?: Record<string, string> }
			const fallbackOptions = create.mock.calls[1]?.[1] as { headers?: Record<string, string> }
			expect(explicitOptions.headers).to.deep.equal({
				"session-id": "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"thread-id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
				"x-client-request-id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
			})
			expect(fallbackOptions.headers).to.deep.equal(explicitOptions.headers)
			expect(explicitRequest.prompt_cache_options).to.deep.equal({ mode: "explicit" })
			expect(JSON.stringify(explicitRequest.messages)).to.contain("prompt_cache_breakpoint")
			expect(fallbackRequest.prompt_cache_options).to.equal(undefined)
			expect(JSON.stringify(fallbackRequest.messages)).not.to.contain("prompt_cache_breakpoint")
			expect(fallbackRequest.prompt_cache_key).to.equal(explicitRequest.prompt_cache_key)
		})

		it("keeps automatic Chat caching for older models while adding a stable key", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					baseUrl: "https://compatible.example/v1",
					modelId: "gpt-5.5-test",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const request = create.mock.calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
			expect(request.prompt_cache_key).to.be.a("string").and.not.equal("")
			expect(request.prompt_cache_options).to.equal(undefined)
			expect(JSON.stringify(request.messages)).not.to.contain("prompt_cache_breakpoint")
		})

		it("classifies official Chat cache write tokens separately from cached and uncached input", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-5.6-sol",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(
				createAsyncIterable([
					{
						choices: [],
						usage: {
							prompt_tokens: 2_000,
							completion_tokens: 300,
							prompt_tokens_details: { cached_tokens: 1_200, cache_write_tokens: 400 },
						},
					},
				]),
			)
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			const chunks = []
			for await (const chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
				chunks.push(chunk)
			}

			const usage = chunks.find((chunk) => chunk.type === "usage")
			expect(usage).to.include({
				inputTokens: 400,
				outputTokens: 300,
				cacheReadTokens: 1_200,
				cacheWriteTokens: 400,
			})
		})

		it("retries an OpenAI Responses 502 before the stream starts", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-5.6-sol",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
				}),
				mode: "act",
			})
			const responsesCreate = createTransportBackedResponsesCreate()
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})
			const transport = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValueOnce(new Response("502 status code (no body)", { status: 502 }))
				.mockResolvedValueOnce(new Response("", { status: 200 }))
			const { observer, statuses } = createProviderAttemptObserver()

			await mockFetchForTesting(transport, async () => {
				const stream = bindProviderAttemptScope(
					handler.createMessage("system prompt", [{ role: "user", content: "Hello" }]),
					observer,
				)
				for await (const _chunk of stream) {
				}
			})

			expect(responsesCreate.mock.calls).to.have.length(2)
			expect(transport.mock.calls).to.have.length(2)
			expect(statuses).to.deep.equal(["failed", "completed"])
		})

		it("does not retry an OpenAI Responses 400 before the stream starts", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-5.6-sol",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
				}),
				mode: "act",
			})
			const protocolError = Object.assign(
				new Error("No tool call found for function call output with call_id fc_compaction."),
				{ status: 400 },
			)
			const responsesCreate = vi.fn().mockRejectedValue(protocolError)
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})

			let caught: unknown
			try {
				for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
				}
			} catch (error) {
				caught = error
			}

			expect(caught).to.equal(protocolError)
			expect(responsesCreate.mock.calls).to.have.length(1)
		})

		it("aborts an idle Responses stream using the configured timeout without provider-level replay", async () => {
			vi.useFakeTimers()
			try {
				const config = OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES })
				;(config as OpenAiProviderConfig & { streamIdleTimeoutSeconds?: number }).streamIdleTimeoutSeconds = 1
				const handler = new OpenAiHandler({
					profile: ApiProfile.create({
						provider: "openai",
						apiKey: "test-api-key",
						modelId: "gpt-5.6-sol",
						openai: config,
					}),
					mode: "act",
					ulid: "task-001",
				})
				let requestSignal: AbortSignal | undefined
				const next = vi.fn(() => new Promise<IteratorResult<unknown>>(() => {}))
				const responsesCreate = vi.fn().mockImplementation((_body, options) => {
					requestSignal = options?.signal
					return Promise.resolve({
						[Symbol.asyncIterator]() {
							return { next }
						},
					})
				})
				vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
					responses: { create: responsesCreate },
				})
				const pending = handler.createMessage("system prompt", [{ role: "user", content: "Hello" }]).next()
				const outcome = pending.then(
					() => undefined,
					(error: unknown) => error,
				)
				await vi.waitFor(() => expect(next.mock.calls).to.have.length(1))

				await vi.advanceTimersByTimeAsync(1_000)

				const error = await outcome
				expect(error).to.be.instanceOf(StreamIdleTimeoutError)
				expect(requestSignal?.aborted).to.equal(true)
				expect(responsesCreate.mock.calls).to.have.length(1)
			} finally {
				vi.useRealTimers()
			}
		})

		it("does not retry a Responses error after streaming has started", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-5.6-sol",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
				}),
				mode: "act",
			})
			const streamError = Object.assign(new Error("502 while streaming"), { status: 502 })
			const responsesCreate = vi.fn().mockResolvedValue({
				async *[Symbol.asyncIterator]() {
					yield { type: "response.output_text.delta", delta: "partial" }
					throw streamError
				},
			})
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})

			const chunks: unknown[] = []
			let caught: unknown
			try {
				for await (const chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
					chunks.push(chunk)
				}
			} catch (error) {
				caught = error
			}

			expect(chunks).to.deep.equal([{ type: "text", text: "partial", provider_metadata: { response_id: undefined } }])
			expect(caught).to.equal(streamError)
			expect(responsesCreate.mock.calls).to.have.length(1)
		})

		it("adds a stable Responses cache key while suppressing explicit controls across dynamic suffixes", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-5.6-sol",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
				}),
				mode: "act",
				workspaceId: "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				ulid: "task-001",
			})
			const responsesCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})

			for await (const _chunk of handler.createMessage("frozen system prompt", [
				{ role: "user", content: "dynamic environment A" },
			])) {
			}
			for await (const _chunk of handler.createMessage("frozen system prompt", [
				{ role: "user", content: "dynamic environment B" },
			])) {
			}

			const firstRequest = responsesCreate.mock.calls[0]?.[0] as OpenAI.Responses.ResponseCreateParamsStreaming
			const secondRequest = responsesCreate.mock.calls[1]?.[0] as OpenAI.Responses.ResponseCreateParamsStreaming
			expect(firstRequest.instructions).to.equal("frozen system prompt")
			expect(firstRequest.prompt_cache_key).to.be.a("string").and.not.equal("")
			expect(secondRequest.prompt_cache_key).to.equal(firstRequest.prompt_cache_key)
			expect(firstRequest.prompt_cache_options).to.equal(undefined)
			expect(JSON.stringify(firstRequest.input)).not.to.contain("prompt_cache_breakpoint")
			expect(JSON.stringify(firstRequest.input?.[0])).to.contain("dynamic environment A")
			expect(JSON.stringify(secondRequest.input?.[0])).to.contain("dynamic environment B")
		})

		it("keeps automatic Responses caching for models below GPT-5.6 while adding a stable key", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-5.5-test",
					openai: OpenAiProviderConfig.create({
						apiFormat: ApiFormat.OPENAI_RESPONSES,
						capabilities: { supportsPromptCache: true },
					}),
				}),
				mode: "act",
			})
			const responsesCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const request = responsesCreate.mock.calls[0]?.[0] as OpenAI.Responses.ResponseCreateParamsStreaming
			expect(request.instructions).to.equal("system prompt")
			expect(request.prompt_cache_key).to.be.a("string").and.not.equal("")
			expect(request.prompt_cache_options).to.equal(undefined)
			expect(JSON.stringify(request.input)).not.to.contain("prompt_cache_breakpoint")
			expect(request.input?.[0]).to.deep.equal({
				role: "user",
				content: [{ type: "input_text", text: "Hello" }],
			})
		})

		it("retries Responses once with automatic caching when an opted-in endpoint rejects explicit controls", async () => {
			const config = OpenAiProviderConfig.create({
				apiFormat: ApiFormat.OPENAI_RESPONSES,
				promptCacheMode: OpenAiPromptCacheMode.OPENAI_PROMPT_CACHE_MODE_EXPLICIT,
			})
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					baseUrl: "https://compatible.example/v1",
					modelId: "gpt-5.6-compatible",
					openai: config,
				}),
				mode: "act",
				workspaceId: "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				ulid: "task-001",
			})
			const responsesCreate = createTransportBackedResponsesCreate()
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})
			const transport = vi
				.fn<typeof globalThis.fetch>()
				.mockResolvedValueOnce(new Response("Unknown parameter: prompt_cache_options", { status: 400 }))
				.mockResolvedValueOnce(new Response("", { status: 200 }))
			const { observer, statuses } = createProviderAttemptObserver()

			await mockFetchForTesting(transport, async () => {
				const stream = bindProviderAttemptScope(
					handler.createMessage("system prompt", [{ role: "user", content: "Hello" }]),
					observer,
				)
				for await (const _chunk of stream) {
				}
			})

			expect(responsesCreate.mock.calls).to.have.length(2)
			expect(transport.mock.calls).to.have.length(2)
			expect(statuses).to.deep.equal(["failed", "completed"])
			const explicitRequest = responsesCreate.mock.calls[0]?.[0] as OpenAI.Responses.ResponseCreateParamsStreaming
			const fallbackRequest = responsesCreate.mock.calls[1]?.[0] as OpenAI.Responses.ResponseCreateParamsStreaming
			const explicitOptions = responsesCreate.mock.calls[0]?.[1] as { headers?: Record<string, string> }
			const fallbackOptions = responsesCreate.mock.calls[1]?.[1] as { headers?: Record<string, string> }
			expect(explicitOptions.headers).to.deep.equal({
				"session-id": "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"thread-id": "task-001",
				"x-client-request-id": "task-001",
			})
			expect(fallbackOptions.headers).to.deep.equal(explicitOptions.headers)
			expect(explicitRequest.instructions).to.equal(undefined)
			expect(explicitRequest.prompt_cache_options).to.deep.equal({ mode: "explicit" })
			expect(explicitRequest.prompt_cache_key).to.match(/^dline_cache_[0-9a-f]{32}$/)
			expect(explicitRequest.input?.[0]).to.deep.equal({
				type: "message",
				role: "developer",
				content: [
					{
						type: "input_text",
						text: "system prompt",
						prompt_cache_breakpoint: { mode: "explicit" },
					},
				],
			})
			expect(fallbackRequest.instructions).to.equal("system prompt")
			expect(fallbackRequest.prompt_cache_options).to.equal(undefined)
			expect(JSON.stringify(fallbackRequest.input)).not.to.contain("prompt_cache_breakpoint")
			expect(fallbackRequest.prompt_cache_key).to.equal(explicitRequest.prompt_cache_key)
		})

		it("routes an OpenAI-compatible profile to the Responses endpoint", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-compatible-responses",
					openai: OpenAiProviderConfig.create({
						apiEndpoint: "responses",
						serviceTier: "priority",
						serviceTierEnabled: true,
						reasoning: { enableThinking: true, effort: "high" },
						capabilities: { maxTokens: 16_384 },
					}),
				}),
				mode: "act",
			})
			const chatCreate = vi.fn()
			const responsesCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create: chatCreate } },
				responses: { create: responsesCreate },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			expect(chatCreate.mock.calls).to.have.length(0)
			expect(responsesCreate.mock.calls).to.have.length(1)
			const requestBody = responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>
			expect(requestBody.instructions).to.equal("system prompt")
			expect(requestBody.prompt_cache_key).to.be.a("string").and.not.equal("")
			expect(requestBody.prompt_cache_options).to.equal(undefined)
			expect(requestBody.service_tier).to.equal("priority")
			expect(requestBody).not.to.have.property("max_output_tokens")
			expect(requestBody.reasoning).to.deep.equal({ effort: "high", summary: "auto" })
		})

		it("omits max_output_tokens from request-scoped compaction Responses", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-compatible-responses",
					openai: OpenAiProviderConfig.create({
						apiEndpoint: "responses",
						capabilities: { maxTokens: 16_384 },
					}),
				}),
				mode: "act",
				workspaceId: "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				ulid: "task-compaction",
			})
			const responsesCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }], undefined, {
				generation: { purpose: "compaction", maxOutputTokens: 30_000 },
			} as any)) {
			}

			const requestBody = responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>
			const requestOptions = responsesCreate.mock.calls[0]?.[1] as { headers?: Record<string, string> }
			expect(requestBody).not.to.have.property("max_output_tokens")
			expect(requestOptions.headers).to.deep.equal({
				"session-id": "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				"thread-id": "task-compaction",
				"x-client-request-id": "task-compaction",
			})
		})

		it("projects hosted web search exactly once and removes the local function declaration", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-compatible-responses",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
				}),
				mode: "act",
			})
			const responsesCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})
			const tools: OpenAI.Chat.ChatCompletionTool[] = [
				{
					type: "function",
					function: { name: "web_search", description: "Local search", parameters: { type: "object" } },
				},
				{
					type: "function",
					function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
				},
			]

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Search" }], tools, {
				serverTools: [ServerTool.WEB_SEARCH],
			})) {
			}

			const request = responsesCreate.mock.calls[0]?.[0]
			const requestTools = request?.tools
			expect(requestTools).to.deep.equal([
				{
					type: "function",
					name: "read_file",
					description: "Read a file",
					parameters: { type: "object" },
					strict: true,
				},
				{ type: "web_search" },
			])
			expect(request?.include).to.deep.equal(["web_search_call.results", "web_search_call.action.sources"])
			expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).to.equal(true)
		})

		it("keeps generate_image local and does not project Hosted image options into the main Responses request", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-compatible-responses",
					usedFor: ["image"],
					imageSource: ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED,
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
				}),
				mode: "act",
			})
			const responsesCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})

			for await (const _chunk of handler.createMessage(
				"system prompt",
				[{ role: "user", content: "Generate an owl" }],
				[
					{
						type: "function",
						function: { name: "generate_image", description: "Local image", parameters: { type: "object" } },
					},
				],
				{
					serverTools: [ServerTool.IMAGE_GENERATION],
					imageGeneration: {
						partialImages: 2,
						size: { width: 2048, height: 1152 },
						references: [
							{
								artifactId: `image:sha256:${"a".repeat(64)}`,
								mimeType: "image/png",
								base64: "reference-image-base64",
							},
						],
					},
				},
			)) {
			}

			const request = responsesCreate.mock.calls[0]?.[0]
			expect(request?.store).to.equal(false)
			expect(request?.tools).to.deep.equal([
				{
					type: "function",
					name: "generate_image",
					description: "Local image",
					parameters: { type: "object" },
					strict: true,
				},
			])
			expect(JSON.stringify(request?.input)).not.to.contain("reference-image-base64")
			expect(handler.supportsServerTool(ServerTool.IMAGE_GENERATION)).to.equal(false)
			expect(handler.getImageGenerationSource()).to.equal(ImageGenerationSource.IMAGE_GENERATION_SOURCE_HOSTED)
		})

		it("keeps local web search as a function when no hosted tool was selected", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-compatible-responses",
					openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
				}),
				mode: "act",
			})
			const responsesCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})

			for await (const _chunk of handler.createMessage(
				"system prompt",
				[{ role: "user", content: "Search" }],
				[
					{
						type: "function",
						function: { name: "web_search", description: "Local search", parameters: { type: "object" } },
					},
				],
			)) {
			}

			expect(responsesCreate.mock.calls[0]?.[0]?.tools).to.deep.equal([
				{
					type: "function",
					name: "web_search",
					description: "Local search",
					parameters: { type: "object" },
					strict: true,
				},
			])
		})

		it("routes the unified OpenAI profile from its typed API format", async () => {
			const config = OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES })
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-5.6-sol",
					modelInfo: {
						id: "gpt-5.6-sol",
						apiFormats: [ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT],
					},
					openai: config,
				}),
				mode: "act",
			})
			const chatCreate = vi.fn()
			const responsesCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create: chatCreate } },
				responses: { create: responsesCreate },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			expect(chatCreate.mock.calls).to.have.length(0)
			expect(responsesCreate.mock.calls).to.have.length(1)
		})

		it.each([
			"chat_completions",
			"responses",
		] as const)("aborts an in-flight OpenAI-compatible %s request", async (apiEndpoint) => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "gpt-compatible-abort",
					openai: OpenAiProviderConfig.create({ apiEndpoint }),
				}),
				mode: "act",
			})
			let releaseStream: (() => void) | undefined
			const streamGate = new Promise<void>((resolve) => {
				releaseStream = resolve
			})
			const stream = {
				[Symbol.asyncIterator]: async function* () {
					await streamGate
				},
			}
			let requestSignal: AbortSignal | undefined
			const create = vi.fn().mockImplementation((_body, options) => {
				requestSignal = options?.signal
				return Promise.resolve(stream)
			})
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
				responses: { create },
			})
			const request = (async () => {
				for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
				}
			})()
			await vi.waitFor(() => expect(create.mock.calls).to.have.length(1))

			;(handler as unknown as { abort?: () => void }).abort?.()
			releaseStream?.()
			await request

			expect(requestSignal).not.to.equal(undefined)
			expect(requestSignal?.aborted).to.equal(true)
		})

		it("uses the Lite o1 message transform and suppresses native tool schemas", async () => {
			const handler = new OpenAiHandler({
				profile: ApiProfile.create({
					provider: "openai",
					apiKey: "test-api-key",
					modelId: "openai/o1-preview",
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			const messages: ClineStorageMessage[] = [
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							function_id: "call_read",
							dline_tid: "tid_read",
							name: "read_file",
							input: { path: "README.md" },
						} as ClineAssistantToolUseBlock,
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							function_id: "call_read",
							dline_tid: "tid_read",
							content: "file contents",
						} as ClineUserToolResultContentBlock,
					],
				},
			]
			const tools: OpenAI.Chat.ChatCompletionTool[] = [
				{
					type: "function",
					function: { name: "read_file", description: "Read a file", parameters: { type: "object" } },
				},
			]

			for await (const _chunk of handler.createMessage("LITE PROFILE PROMPT", messages, tools)) {
			}

			const requestBody = create.mock.calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParams
			const assistantMessage = requestBody.messages[1] as OpenAI.Chat.ChatCompletionAssistantMessageParam
			expect(requestBody.messages[0]).to.deep.equal({ role: "user", content: "LITE PROFILE PROMPT" })
			expect(assistantMessage.role).to.equal("assistant")
			expect(assistantMessage.content).to.contain("Tool Call: read_file")
			expect(assistantMessage).not.to.have.property("tool_calls")
			expect(requestBody.messages[2]).to.deep.equal({ role: "user", content: "file contents" })
			expect(requestBody).not.to.have.property("tools")
			expect(JSON.stringify(requestBody)).not.to.contain("Instructions for Formulating Your Response")
		})
	})
})

describe("OpenAiCodexHandler request configuration", () => {
	it("adds service tier to the shared SDK and fallback request body", () => {
		const handler = new OpenAiCodexHandler({
			profile: ApiProfile.create({
				id: "codex-service-tier",
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
				openaiCodex: OpenAiCodexProviderConfig.create({ serviceTier: "scale" }),
			}),
			mode: "act",
		})

		const body = (
			handler as unknown as {
				buildRequestBody: (...args: unknown[]) => Record<string, unknown>
			}
		).buildRequestBody({ id: "gpt-5.6-sol", info: {} }, [], "system")

		expect(body.service_tier).to.equal("scale")
	})

	it("suppresses service tier when the Codex Profile disables Service Tier", () => {
		const handler = new OpenAiCodexHandler({
			profile: ApiProfile.create({
				id: "codex-service-tier-disabled",
				provider: "openai-codex",
				modelId: "gpt-5.6-sol",
				openaiCodex: OpenAiCodexProviderConfig.create({ serviceTier: "scale", serviceTierEnabled: false }),
			}),
			mode: "act",
		})

		const body = (
			handler as unknown as {
				buildRequestBody: (...args: unknown[]) => Record<string, unknown>
			}
		).buildRequestBody({ id: "gpt-5.6-sol", info: {} }, [], "system")

		expect(body).not.to.have.property("service_tier")
	})
})

describe("OpenAiCodexHandler account usage", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("maps the short and weekly Codex quota windows", async () => {
		vi.spyOn(openAiCodexOAuthManager, "getCredentialContext").mockResolvedValue({
			accessToken: "access-token",
			accountId: "account-123",
			expires: 1_900_000_000_000,
		})
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					rate_limit: {
						primary_window: {
							used_percent: 25,
							limit_window_seconds: 18_000,
							reset_at: 1_800_000_000,
						},
						secondary_window: {
							used_percent: 60,
							limit_window_seconds: 604_800,
							reset_at: 1_800_500_000,
						},
					},
					credits: { balance: "7.50" },
				}),
			})
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ credits: [], total_count: 0 }),
			})
		const handler = new OpenAiCodexHandler({
			profile: ApiProfile.create({ id: "codex-usage", provider: "openai-codex", modelId: "gpt-5.6-sol" }),
			mode: "act",
		})

		const usage = await mockFetchForTesting(request, () => handler.getAccountUsage())

		expect(request.mock.calls).to.have.length(2)
		expect(request.mock.calls[0][0]).to.equal("https://chatgpt.com/backend-api/wham/usage")
		expect(request.mock.calls[1][0]).to.equal("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits")
		for (const call of request.mock.calls) {
			expect(call[1].headers).to.include({
				Authorization: "Bearer access-token",
				"ChatGPT-Account-Id": "account-123",
			})
		}
		expect(usage).to.deep.equal({
			currency: "USD",
			remainingBalance: 7.5,
			planType: undefined,
			allowed: undefined,
			limitReached: undefined,
			quotas: [
				{
					type: "5hour",
					label: "5 hour",
					shortLabel: "5h",
					used: 25,
					limit: 100,
					windowSeconds: 18_000,
					resetAt: new Date(1_800_000_000 * 1_000).toISOString(),
				},
				{
					type: "weekly",
					label: "7 day",
					shortLabel: "7d",
					used: 60,
					limit: 100,
					windowSeconds: 604_800,
					resetAt: new Date(1_800_500_000 * 1_000).toISOString(),
				},
			],
			resetCreditsAvailableCount: 0,
			resetCredits: [],
			isAvailable: true,
		})
	})
})
