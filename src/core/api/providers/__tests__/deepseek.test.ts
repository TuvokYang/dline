import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { BaseProviderConfig } from "@shared/proto/dline/provider/common"
import { expect } from "chai"
import type OpenAI from "openai"
import { afterEach, describe, it, vi } from "vitest"
import type { ClineStorageMessage } from "@/shared/messages/content"
import { createRequestApiScope } from "../../../task/RequestApiScope"
import type { ApiRequestOptions } from "../../index"
import { OutputLimitExceededError } from "../../stream/OutputLimitExceededError"
import { DeepSeekHandler } from "../deepseek"

interface StreamChunk {
	choices?: Array<{
		delta?: {
			content?: string
			reasoning_content?: string
			tool_calls?: Array<{
				index: number
				id?: string
				function?: { name?: string; arguments?: string }
			}>
		}
		finish_reason?: string | null
	}>
	usage?: {
		prompt_tokens?: number
		completion_tokens?: number
		prompt_cache_hit_tokens?: number
		prompt_cache_miss_tokens?: number
	}
}

interface FakeClient {
	chat: {
		completions: {
			create: ReturnType<typeof vi.fn>
		}
	}
}

/**
 * Create an async iterable for mocked streaming responses.
 *
 * @param data Stream chunks to yield.
 * @returns Async iterable yielding provided chunks.
 */
function createStream(data: readonly StreamChunk[] = []): AsyncIterable<StreamChunk> {
	return {
		// Yield mocked OpenAI stream chunks in call order.
		[Symbol.asyncIterator]: async function* streamChunks() {
			yield* data
		},
	}
}

/**
 * Collect all chunks emitted by a DeepSeek handler request.
 *
 * @param handler DeepSeek handler under test.
 * @returns Stream chunks emitted by createMessage.
 */
async function collectChunks(
	handler: DeepSeekHandler,
	messages: ClineStorageMessage[] = [{ role: "user", content: "hi" }],
	tools?: OpenAI.Chat.ChatCompletionTool[],
	options?: ApiRequestOptions,
): Promise<unknown[]> {
	const chunks: unknown[] = []
	for await (const chunk of handler.createMessage("system", messages, tools, options)) {
		chunks.push(chunk)
	}
	return chunks
}

function contextPressureHistory(): ClineStorageMessage[] {
	return [
		{ role: "user", content: "initial task" },
		{
			role: "assistant",
			content: "earlier response",
			metrics: { tokens: { prompt: 100_000, completion: 100, cached: 0 } },
		},
		{ role: "user", content: "next request" },
		{
			role: "assistant",
			content: "previous response",
			metrics: { tokens: { prompt: 630_000, completion: 100, cached: 0 } },
		},
		{ role: "user", content: "continue" },
	]
}

describe("DeepSeekHandler", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	describe("createMessage", () => {
		it("routes a profile-selected Responses request through the DeepSeek Responses client", async () => {
			const profile = ApiProfile.create({
				provider: "deepseek",
				apiKey: "test-api-key",
				modelId: "deepseek-v4-flash",
				deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
			})
			const handler = new DeepSeekHandler({ profile, mode: "act" })
			const chatCreate = vi.fn().mockResolvedValue(createStream())
			const responsesCreate = vi.fn().mockResolvedValue(createStream())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				chat: { completions: { create: chatCreate } },
				responses: { create: responsesCreate },
			})

			await collectChunks(handler)

			expect(responsesCreate.mock.calls).to.have.length(1)
			expect(chatCreate.mock.calls).to.have.length(0)
			const request = responsesCreate.mock.calls[0]?.[0]
			expect(request).to.deep.include({ model: "deepseek-v4-flash", stream: true, instructions: "system" })
			expect(request).not.to.have.property("previous_response_id")
			expect(request).not.to.have.property("store")
		})

		it("projects hosted web search exactly once in DeepSeek Responses requests", async () => {
			const handler = new DeepSeekHandler({
				profile: ApiProfile.create({
					provider: "deepseek",
					apiKey: "test-api-key",
					modelId: "deepseek-v4-flash",
					deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
				}),
				mode: "act",
			})
			const responsesCreate = vi.fn().mockResolvedValue(createStream())
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
					function: { name: "read_file", description: "Read", parameters: { type: "object" } },
				},
			]

			await collectChunks(handler, undefined, tools, { serverTools: [ServerTool.WEB_SEARCH] })

			const request = responsesCreate.mock.calls[0]?.[0]
			expect(request?.tools).to.deep.equal([
				{
					type: "function",
					name: "read_file",
					description: "Read",
					parameters: { type: "object" },
					strict: false,
				},
				{ type: "web_search" },
			])
			expect(request?.include).to.deep.equal(["web_search_call.results", "web_search_call.action.sources"])
			expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).to.equal(true)
		})

		it("keeps the Responses output ceiling independent from prior context usage", async () => {
			const profile = ApiProfile.create({
				provider: "deepseek",
				apiKey: "test-api-key",
				modelId: "deepseek-v4-flash",
				deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
			})
			const handler = new DeepSeekHandler({ profile, mode: "act" })
			const responsesCreate = vi.fn().mockResolvedValue(createStream())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})

			await collectChunks(handler, contextPressureHistory())

			expect(responsesCreate.mock.calls[0]?.[0]?.max_output_tokens).to.equal(384_000)
		})

		it("uses the request-scoped compaction cap for DeepSeek Responses", async () => {
			const handler = new DeepSeekHandler({
				profile: ApiProfile.create({
					provider: "deepseek",
					apiKey: "test-api-key",
					modelId: "deepseek-v4-flash",
					deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
				}),
				mode: "act",
			})
			const responsesCreate = vi.fn().mockResolvedValue(createStream())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})

			await collectChunks(handler, undefined, undefined, {
				generation: { purpose: "compaction", maxOutputTokens: 30_000 },
			} as any)

			expect(responsesCreate.mock.calls[0]?.[0]?.max_output_tokens).to.equal(30_000)
		})

		it("keeps the Chat output ceiling independent from prior context usage", async () => {
			const handler = new DeepSeekHandler({
				profile: ApiProfile.create({
					provider: "deepseek",
					apiKey: "test-api-key",
					modelId: "deepseek-v4-flash",
					deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(createStream())
			vi.spyOn(handler as unknown as { ensureClient: () => FakeClient }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			await collectChunks(handler, contextPressureHistory())

			expect(create.mock.calls[0]?.[0]?.max_completion_tokens).to.equal(384_000)
		})

		it("uses the request-scoped compaction cap for DeepSeek Chat", async () => {
			const handler = new DeepSeekHandler({
				profile: ApiProfile.create({
					provider: "deepseek",
					apiKey: "test-api-key",
					modelId: "deepseek-v4-flash",
					deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(createStream())
			vi.spyOn(handler as unknown as { ensureClient: () => FakeClient }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			await collectChunks(handler, undefined, undefined, {
				generation: { purpose: "compaction", maxOutputTokens: 30_000 },
			} as any)

			expect(create.mock.calls[0]?.[0]?.max_completion_tokens).to.equal(30_000)
		})

		it("emits reasoning before tool calls when DeepSeek coalesces them in one Chat delta", async () => {
			const handler = new DeepSeekHandler({
				profile: ApiProfile.create({
					provider: "deepseek",
					apiKey: "test-api-key",
					modelId: "deepseek-v4-flash",
					deepseek: BaseProviderConfig.create({
						apiFormat: ApiFormat.OPENAI_CHAT,
						reasoning: { effort: "high" },
					}),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(
				createStream([
					{
						choices: [
							{
								delta: {
									reasoning_content: "inspect before searching",
									tool_calls: [
										{
											index: 0,
											id: "call_search",
											function: { name: "search_files", arguments: '{"path":"."}' },
										},
									],
								},
							},
						],
					},
				]),
			)
			vi.spyOn(handler as unknown as { ensureClient: () => FakeClient }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			const chunks = await collectChunks(handler)

			expect(chunks).to.deep.equal([
				{ type: "reasoning", reasoning: "inspect before searching" },
				{
					type: "tool_calls",
					function_id: "call_search",
					tool_index: 0,
					tool_call: { function: { name: "search_files", arguments: '{"path":"."}' } },
				},
			])
		})

		it("throws a typed output-limit error for DeepSeek Chat finish_reason length", async () => {
			const handler = new DeepSeekHandler({
				profile: ApiProfile.create({
					provider: "deepseek",
					apiKey: "test-api-key",
					modelId: "deepseek-v4-flash",
					deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})
			const create = vi.fn().mockResolvedValue(createStream([{ choices: [{ delta: {}, finish_reason: "length" }] }]))
			vi.spyOn(handler as unknown as { ensureClient: () => FakeClient }, "ensureClient").mockReturnValue({
				chat: { completions: { create } },
			})

			let caught: unknown
			try {
				await collectChunks(handler)
			} catch (error) {
				caught = error
			}

			expect(caught).to.be.instanceOf(OutputLimitExceededError)
			expect(caught).to.deep.include({ protocol: "openai_chat", reason: "length" })
		})

		it("projects canonical function identities into DeepSeek Responses history without provider IDs", async () => {
			const profile = ApiProfile.create({
				provider: "deepseek",
				apiKey: "test-api-key",
				modelId: "deepseek-v4-flash",
				deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
			})
			const handler = new DeepSeekHandler({ profile, mode: "act" })
			const responsesCreate = vi.fn().mockResolvedValue(createStream())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				responses: { create: responsesCreate },
			})
			const history: ClineStorageMessage[] = [
				{
					role: "assistant",
					content: [
						{
							type: "tool_use",
							function_id: "call_read_1",
							dline_tid: "dline_tid_read_1",
							name: "read_file",
							input: { path: "README.md" },
						},
					],
				},
				{
					role: "user",
					content: [
						{
							type: "tool_result",
							function_id: "call_read_1",
							dline_tid: "dline_tid_read_1",
							content: "file contents",
						},
					],
				},
			]

			for await (const _chunk of handler.createMessage("system", history)) {
				// Empty mocked stream.
			}

			const input = responsesCreate.mock.calls[0]?.[0]?.input
			expect(input).to.deep.equal([
				{
					type: "function_call",
					call_id: "call_read_1",
					name: "read_file",
					arguments: '{"path":"README.md"}',
				},
				{ type: "function_call_output", call_id: "call_read_1", output: "file contents" },
			])
			expect(JSON.stringify(input)).not.to.match(/dline_tid|item_id|tool_use_id/)
		})

		it("routes a profile-selected Anthropic request through /anthropic with effort output_config", async () => {
			const profile = ApiProfile.create({
				provider: "deepseek",
				apiKey: "test-api-key",
				baseUrl: "https://api.deepseek.com/",
				modelId: "deepseek-v4-pro",
				deepseek: BaseProviderConfig.create({
					apiFormat: ApiFormat.ANTHROPIC_CHAT,
					reasoning: { effort: "max" },
				}),
			})
			const handler = new DeepSeekHandler({ profile, mode: "act" })
			const messagesCreate = vi.fn().mockResolvedValue(createStream())
			;(handler as unknown as { anthropicClient?: unknown }).anthropicClient = {
				messages: { create: messagesCreate },
			}
			vi.spyOn(handler as unknown as { ensureClient: () => FakeClient }, "ensureClient").mockReturnValue({
				chat: { completions: { create: vi.fn().mockResolvedValue(createStream()) } },
			})

			await collectChunks(handler)

			expect(messagesCreate.mock.calls).to.have.length(1)
			expect(messagesCreate.mock.calls[0]?.[0]).to.deep.include({
				model: "deepseek-v4-pro",
				stream: true,
				output_config: { effort: "max" },
			})
			expect((handler as unknown as { getAnthropicBaseUrl: () => string }).getAnthropicBaseUrl()).to.equal(
				"https://api.deepseek.com/anthropic",
			)
		})

		it("projects hosted web search exactly once in DeepSeek Anthropic requests", async () => {
			const handler = new DeepSeekHandler({
				profile: ApiProfile.create({
					provider: "deepseek",
					apiKey: "test-api-key",
					modelId: "deepseek-v4-pro",
					deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.ANTHROPIC_CHAT }),
				}),
				mode: "act",
			})
			const messagesCreate = vi.fn().mockResolvedValue(createStream())
			;(handler as unknown as { anthropicClient?: unknown }).anthropicClient = {
				messages: { create: messagesCreate },
			}
			const tools: OpenAI.Chat.ChatCompletionTool[] = [
				{
					type: "function",
					function: { name: "web_search", description: "Local search", parameters: { type: "object" } },
				},
				{
					type: "function",
					function: { name: "read_file", description: "Read", parameters: { type: "object" } },
				},
			]

			await collectChunks(handler, undefined, tools, { serverTools: [ServerTool.WEB_SEARCH] })

			expect(messagesCreate.mock.calls[0]?.[0]?.tools).to.deep.equal([
				{
					name: "read_file",
					description: "Read",
					input_schema: { type: "object" },
				},
				{ type: "web_search_20260318", name: "web_search", allowed_callers: ["direct"] },
			])
			expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).to.equal(true)
		})

		it("keeps the Anthropic output ceiling independent from prior context usage", async () => {
			const handler = new DeepSeekHandler({
				profile: ApiProfile.create({
					provider: "deepseek",
					apiKey: "test-api-key",
					modelId: "deepseek-v4-pro",
					deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.ANTHROPIC_CHAT }),
				}),
				mode: "act",
			})
			const messagesCreate = vi.fn().mockResolvedValue(createStream())
			;(handler as unknown as { anthropicClient?: unknown }).anthropicClient = {
				messages: { create: messagesCreate },
			}

			await collectChunks(handler, contextPressureHistory())

			expect(messagesCreate.mock.calls[0]?.[0]?.max_tokens).to.equal(384_000)
		})

		it("uses the request-scoped compaction cap for DeepSeek Anthropic Messages", async () => {
			const handler = new DeepSeekHandler({
				profile: ApiProfile.create({
					provider: "deepseek",
					apiKey: "test-api-key",
					modelId: "deepseek-v4-pro",
					deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.ANTHROPIC_CHAT }),
				}),
				mode: "act",
			})
			const messagesCreate = vi.fn().mockResolvedValue(createStream())
			;(handler as unknown as { anthropicClient?: unknown }).anthropicClient = {
				messages: { create: messagesCreate },
			}

			await collectChunks(handler, undefined, undefined, {
				generation: { purpose: "compaction", maxOutputTokens: 30_000 },
			} as any)

			expect(messagesCreate.mock.calls[0]?.[0]?.max_tokens).to.equal(30_000)
		})

		for (const [configuredEffort, expectedEffort] of [
			["low", "low"],
			["high", "high"],
			["max", "max"],
			["xhigh", "max"],
		] as const) {
			it(`normalizes ${configuredEffort} thinking effort to ${expectedEffort}`, async () => {
				const handler = new DeepSeekHandler({
					profile: ApiProfile.create({
						provider: "deepseek",
						apiKey: "test-api-key",
						modelId: "deepseek-v4-pro",
						deepseek: BaseProviderConfig.create({
							apiFormat: ApiFormat.OPENAI_CHAT,
							reasoning: { effort: configuredEffort },
						}),
					}),
					mode: "act",
				})
				const create = vi.fn().mockResolvedValue(createStream())
				vi.spyOn(handler as unknown as { ensureClient: () => FakeClient }, "ensureClient").mockReturnValue({
					chat: { completions: { create } },
				})

				await collectChunks(handler)

				expect(create.mock.calls[0]?.[0]?.reasoning_effort).to.equal(expectedEffort)
			})
		}

		it("reports non-cached input tokens separately from DeepSeek cache tokens", async () => {
			const handler = new DeepSeekHandler({
				profile: ApiProfile.create({
					provider: "deepseek",
					apiKey: "test-api-key",
					modelId: "deepseek-v4-pro",
					deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})
			const fakeClient: FakeClient = {
				chat: {
					completions: {
						create: vi.fn().mockResolvedValue(
							createStream([
								{
									choices: [{}],
									usage: {
										prompt_tokens: 1_000,
										completion_tokens: 25,
										prompt_cache_hit_tokens: 900,
										prompt_cache_miss_tokens: 50,
									},
								},
							]),
						),
					},
				},
			}
			vi.spyOn(handler as unknown as { ensureClient: () => FakeClient }, "ensureClient").mockReturnValue(fakeClient)

			const chunks = await collectChunks(handler)

			expect(chunks).to.deep.equal([
				{
					type: "usage",
					inputTokens: 50,
					outputTokens: 25,
					cacheWriteTokens: 50,
					cacheReadTokens: 900,
					totalCost: 0.00047250000000000005,
				},
			])
		})

		it("passes an AbortSignal to the SDK and aborts an in-flight request", async () => {
			const handler = new DeepSeekHandler({
				profile: ApiProfile.create({
					provider: "deepseek",
					apiKey: "test-api-key",
					modelId: "deepseek-v4-pro",
					deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
				}),
				mode: "act",
			})
			let requestSignal: AbortSignal | undefined
			const create = vi.fn().mockImplementation((_body, options) => {
				requestSignal = options.signal
				return new Promise((_resolve, reject) => {
					requestSignal?.addEventListener("abort", () => reject(requestSignal?.reason), { once: true })
				})
			})
			const fakeClient: FakeClient = { chat: { completions: { create } } }
			vi.spyOn(handler as unknown as { ensureClient: () => FakeClient }, "ensureClient").mockReturnValue(fakeClient)

			const request = collectChunks(handler)
			await vi.waitFor(() => expect(create.mock.calls).to.have.length(1))
			handler.abort()

			let rejected = false
			try {
				await request
			} catch {
				rejected = true
			}
			expect(rejected).to.equal(true)
			expect(requestSignal?.aborted).to.equal(true)
		})
	})

	it("uses model metadata supplied by the profile registry", () => {
		const modelInfo = {
			id: "deepseek-dynamic",
			name: "DeepSeek Dynamic",
			capabilities: { maxTokens: 12_345, supportsReasoning: true },
		}
		const handler = new DeepSeekHandler({
			profile: ApiProfile.create({
				provider: "deepseek",
				modelId: "deepseek-dynamic",
				modelInfo: modelInfo as NonNullable<ApiProfile["modelInfo"]>,
			}),
			mode: "act",
		})

		const resolved = handler.getModel()
		expect(resolved.id).to.equal("deepseek-dynamic")
		expect(resolved.info.id).to.equal("deepseek-dynamic")
		expect(resolved.info.name).to.equal("DeepSeek Dynamic")
		expect(resolved.info.capabilities?.maxTokens).to.equal(12_345)
		expect(resolved.info.capabilities?.supportsReasoning).to.equal(true)
	})

	it("defaults DeepSeek flash to Chat and freezes Auto Web Search as local", () => {
		const handler = new DeepSeekHandler({
			profile: ApiProfile.create({
				provider: "deepseek",
				apiKey: "test-api-key",
				modelId: "deepseek-v4-flash",
			}),
			mode: "act",
		})

		expect(handler.getModel().info.apiFormats?.[0]).to.equal(ApiFormat.OPENAI_CHAT)
		expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).to.equal(false)
		expect(createRequestApiScope(handler, "act", undefined, true).webSearchRoutingPlan).to.deep.include({
			route: "local",
			localToolEnabled: true,
			serverTools: [],
		})
	})

	it("defaults DeepSeek pro to Chat while preserving its compatibility formats", () => {
		const handler = new DeepSeekHandler({
			profile: ApiProfile.create({
				provider: "deepseek",
				modelId: "deepseek-v4-pro",
			}),
			mode: "act",
		})

		expect(handler.getModel().info.apiFormats).to.deep.equal([
			ApiFormat.OPENAI_CHAT,
			ApiFormat.OPENAI_RESPONSES,
			ApiFormat.ANTHROPIC_CHAT,
		])
		expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).to.equal(false)
	})

	for (const apiFormat of [ApiFormat.OPENAI_RESPONSES, ApiFormat.ANTHROPIC_CHAT]) {
		it(`uses hosted Web Search when DeepSeek explicitly selects ${ApiFormat[apiFormat]}`, () => {
			const handler = new DeepSeekHandler({
				profile: ApiProfile.create({
					provider: "deepseek",
					modelId: "deepseek-v4-pro",
					deepseek: BaseProviderConfig.create({ apiFormat }),
				}),
				mode: "act",
			})

			expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).to.equal(true)
			expect(createRequestApiScope(handler, "act", undefined, true).webSearchRoutingPlan).to.deep.include({
				route: "hosted",
				localToolEnabled: false,
				serverTools: [ServerTool.WEB_SEARCH],
			})
		})
	}

	it("reports hosted web search unavailable for the Chat transport", () => {
		const handler = new DeepSeekHandler({
			profile: ApiProfile.create({
				provider: "deepseek",
				modelId: "deepseek-v4-pro",
				deepseek: BaseProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
			}),
			mode: "act",
		})

		expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).to.equal(false)
	})
})
