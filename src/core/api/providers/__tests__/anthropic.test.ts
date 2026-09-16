import { anthropicModels } from "@shared/api"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { expect } from "chai"
import should from "should"
import { afterEach, describe, it, vi } from "vitest"
import type { ApiRequestOptions } from "../../index"
import { ANTHROPIC_FAST_MODE_BETA, AnthropicHandler } from "../anthropic"

describe("AnthropicHandler", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	const createAsyncIterable = (data: readonly unknown[] = []) => ({
		[Symbol.asyncIterator]: async function* () {
			yield* data
		},
	})

	describe("getModel", () => {
		it("should preserve resolved profile model metadata", () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-sonnet-4-6",
					modelInfo: anthropicModels["claude-sonnet-4-6"],
					anthropic: { reasoning: { enableThinking: true, thinkingBudget: 2_048 } },
				}),
				mode: "act",
			})

			const result = handler.getModel()

			result.id.should.equal("claude-sonnet-4-6")
			should(result.info.capabilities?.supportsTools).equal(true)
			// Long context (1M) is enabled by default when the profile does not opt out.
			should(result.info.capabilities?.contextWindow).equal(1_000_000)
		})

		it("should merge provider overrides into registry model metadata", () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-opus-4-7",
					anthropic: {
						capabilities: {
							maxTokens: 12_345,
							supportsPromptCache: false,
						},
						pricing: {
							inputPrice: 0.5,
						},
					},
				}),
				mode: "act",
			})

			const result = handler.getModel()

			result.id.should.equal("claude-opus-4-7")
			result.info.id.should.equal("claude-opus-4-7")
			// Long context defaults to on, resolving to the 1M tier.
			should(result.info.capabilities?.contextWindow).equal(1_000_000)
			should(result.info.capabilities?.maxTokens).equal(12_345)
			should(result.info.capabilities?.supportsPromptCache).equal(false)
			should(result.info.pricing?.inputPrice).equal(0.5)
		})

		it("should return the fast mode model when configured", () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({ provider: "anthropic", apiKey: "test-api-key", modelId: "claude-opus-5:fast" }),
				mode: "act",
			})

			const result = handler.getModel()

			result.id.should.equal("claude-opus-5:fast")
			should(result.info.capabilities?.contextWindow).equal(1_000_000)
			result.info.apiFormats?.should.deepEqual([ApiFormat.ANTHROPIC_CHAT])
		})

		it("should keep the base model id when long context is enabled", () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-sonnet-4-6",
					anthropic: { enableLongContext: true },
				}),
				mode: "act",
			})

			const result = handler.getModel()

			result.id.should.equal("claude-sonnet-4-6")
			should(result.info.capabilities?.contextWindow).equal(1_000_000)
		})

		it("should return the 4.7 model when configured", () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({ provider: "anthropic", apiKey: "test-api-key", modelId: "claude-opus-4-7" }),
				mode: "act",
			})

			const result = handler.getModel()

			result.id.should.equal("claude-opus-4-7")
			should(result.info.capabilities?.contextWindow).equal(1_000_000)
			result.info.apiFormats?.should.deepEqual([ApiFormat.ANTHROPIC_CHAT])
		})

		it("should preserve a custom model id when profile modelInfo is missing", () => {
			const customModelId = "custom-claude-compatible-model"
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: customModelId,
					anthropic: {
						customModelEnabled: true,
						capabilities: {
							maxTokens: 12_345,
							contextWindow: 67_890,
							supportsImages: false,
							supportsPromptCache: false,
							supportsReasoning: false,
						},
						pricing: {
							inputPrice: 0.5,
							outputPrice: 1.5,
						},
					},
				}),
				mode: "act",
			})

			const result = handler.getModel()

			result.id.should.equal(customModelId)
			result.info.id.should.equal(customModelId)
			should(result.info.capabilities?.maxTokens).equal(12_345)
			should(result.info.capabilities?.supportsPromptCache).equal(false)
		})

		it("only reports the known hosted web search tool as supported", () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({ provider: "anthropic", modelId: "claude-sonnet-4-6" }),
				mode: "act",
			})

			expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).to.equal(true)
			expect(handler.supportsServerTool(ServerTool.SERVER_TOOL_UNSPECIFIED)).to.equal(false)
		})

		it("projects the fixed Anthropic transport into custom model metadata", () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					modelId: "custom-anthropic-model",
					anthropic: {
						customModelEnabled: true,
						capabilities: { supportsTools: true, tools: [ServerTool.WEB_SEARCH] },
					},
				}),
				mode: "act",
			})

			expect(handler.getModel().info.apiFormats?.[0]).to.equal(ApiFormat.ANTHROPIC_CHAT)
			// A profile records switches, not capabilities. A free-form model id has
			// no registry entry, so it cannot gain a hosted declaration this way.
			expect(handler.getModel().info.capabilities?.tools).to.equal(undefined)
		})

		it("reports the transport it will speak so routing does not guess from metadata", () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({ provider: "anthropic", modelId: "custom-anthropic-model" }),
				mode: "act",
			})

			expect(handler.getSelectedApiFormat()).to.equal(ApiFormat.ANTHROPIC_CHAT)
		})
	})

	describe("createMessage", () => {
		it("disables SDK retries so Dline owns the retry policy", () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-sonnet-4-6",
				}),
				mode: "act",
			})

			const client = (handler as unknown as { ensureClient: () => { maxRetries: number } }).ensureClient()

			expect(client.maxRetries).to.equal(0)
		})

		it("projects hosted web search exactly once and removes the local Anthropic tool", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-sonnet-4-6",
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage(
				"system prompt",
				[{ role: "user", content: "Search" }],
				[
					{
						name: "web_search",
						description: "Local search",
						input_schema: { type: "object", properties: {} },
					},
					{
						name: "read_file",
						description: "Read",
						input_schema: { type: "object", properties: {} },
					},
				],
				{ serverTools: [ServerTool.WEB_SEARCH] },
			)) {
			}

			expect(standardCreate.mock.calls[0]?.[0]?.tools).to.deep.equal([
				{
					name: "read_file",
					description: "Read",
					input_schema: { type: "object", properties: {} },
				},
				{ type: "web_search_20260318", name: "web_search", allowed_callers: ["direct"] },
			])
			// `any` admits only client tools, so forcing it would make the hosted declaration unreachable.
			expect(standardCreate.mock.calls[0]?.[0]?.tool_choice).to.deep.equal({ type: "auto" })
			expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).to.equal(true)
		})

		it("still forces a tool choice when the request carries no hosted server tools", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-sonnet-4-6",
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage(
				"system prompt",
				[{ role: "user", content: "Read" }],
				[
					{
						name: "read_file",
						description: "Read",
						input_schema: { type: "object", properties: {} },
					},
				],
			)) {
			}

			expect(standardCreate.mock.calls[0]?.[0]?.tools).to.deep.equal([
				{
					name: "read_file",
					description: "Read",
					input_schema: { type: "object", properties: {} },
				},
			])
			expect(standardCreate.mock.calls[0]?.[0]?.tool_choice).to.deep.equal({ type: "any" })
		})

		it("never forces a tool choice on Fable 5.1, which rejects forced tool use", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-fable-5-1",
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage(
				"system prompt",
				[{ role: "user", content: "Read" }],
				[
					{
						name: "read_file",
						description: "Read",
						input_schema: { type: "object", properties: {} },
					},
				],
			)) {
			}

			expect(standardCreate.mock.calls[0]?.[0]?.model).to.equal("claude-fable-5-1")
			expect(standardCreate.mock.calls[0]?.[0]?.tool_choice).to.deep.equal({ type: "auto" })
		})

		it("does not force hosted Web Search when no local Anthropic functions are present", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-sonnet-4-6",
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage(
				"system prompt",
				[{ role: "user", content: "Answer without searching unless needed" }],
				undefined,
				{ serverTools: [ServerTool.WEB_SEARCH] },
			)) {
			}

			expect(standardCreate.mock.calls[0]?.[0]?.tools).to.deep.equal([
				{ type: "web_search_20260318", name: "web_search", allowed_callers: ["direct"] },
			])
			should(standardCreate.mock.calls[0]?.[0]?.tool_choice).equal(undefined)
		})

		it("should route fast mode requests through the beta messages API", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({ provider: "anthropic", apiKey: "test-api-key", modelId: "claude-opus-5:fast" }),
				mode: "act",
			})

			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			const betaCreate = vi.fn().mockImplementation(function (this: { _client?: object }, _params: unknown) {
				should.exist(this._client)
				return Promise.resolve(createAsyncIterable())
			})

			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: {
					create: standardCreate,
				},
				beta: {
					messages: {
						_client: {},
						create: betaCreate,
					},
				},
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			expect(standardCreate)
			expect(betaCreate)
			const callArgs = betaCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			expect(callArgs?.model).to.equal("claude-opus-5")
			expect(callArgs?.betas).to.deep.equal([ANTHROPIC_FAST_MODE_BETA])
			expect(callArgs?.speed).to.equal("fast")
			expect(callArgs?.stream).to.equal(true)
		})

		it("should keep the native model id for Opus 4.8 fast mode", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-opus-4-8:fast",
					anthropic: { enableLongContext: true },
				}),
				mode: "act",
			})

			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			const betaCreate = vi.fn().mockImplementation(function (this: { _client?: object }, _params: unknown) {
				should.exist(this._client)
				return Promise.resolve(createAsyncIterable())
			})

			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: {
					create: standardCreate,
				},
				beta: {
					messages: {
						_client: {},
						create: betaCreate,
					},
				},
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			expect(standardCreate)
			expect(betaCreate)
			const callArgs = betaCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			expect(callArgs?.model).to.equal("claude-opus-4-8")
			expect(callArgs?.betas).to.deep.equal([ANTHROPIC_FAST_MODE_BETA])
			expect(callArgs?.speed).to.equal("fast")
			expect(callArgs?.stream).to.equal(true)
		})

		it("should keep the Claude Opus 5 model id without a legacy long-context suffix or beta header", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-opus-5",
					anthropic: {
						enableLongContext: true,
						reasoning: { effort: "high" },
						capabilities: {
							contextWindow: 1_250_000,
							contextWindowTiers: [
								{ id: "standard", contextWindow: 200_000, label: "200K" },
								{ id: "long", contextWindow: 1_000_000, label: "1M", apiModelSuffix: ":1m" },
							],
						},
					},
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			expect(requestBody?.model).to.equal("claude-opus-5")
			expect(handler.getModel().info.capabilities?.contextWindow).to.equal(1_250_000)
			expect(handler.getModel().info.capabilities?.contextWindowTiers).to.equal(undefined)
			expect(requestBody?.thinking).to.deep.equal({ type: "adaptive" })
			should(standardCreate.mock.calls[0]?.[1]).equal(undefined)
		})

		it("should ignore stale context tiers on official native-1M models", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-opus-4-7",
					anthropic: {
						enableLongContext: false,
						capabilities: {
							contextWindowTiers: [
								{ id: "standard", contextWindow: 160_000, label: "160K" },
								{ id: "long", contextWindow: 1_500_000, label: "1.5M", apiModelSuffix: ":1m" },
							],
						},
					},
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			expect(requestBody?.model).to.equal("claude-opus-4-7")
			expect(handler.getModel().info.capabilities?.contextWindow).to.equal(1_000_000)
			expect(handler.getModel().info.capabilities?.contextWindowTiers).to.equal(undefined)
			should(standardCreate.mock.calls[0]?.[1]).equal(undefined)
		})

		it("should append an explicitly configured custom long-context suffix at the API boundary", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "vendor-tiered",
					anthropic: {
						customModelEnabled: true,
						enableLongContext: true,
						reasoning: { effort: "high" },
						capabilities: {
							supportsReasoning: true,
							thinking: {
								supported: true,
								mode: "effort",
								effortLevels: ["none", "low", "medium", "high"],
							},
							contextWindowTiers: [
								{ id: "standard", contextWindow: 200_000, label: "200K" },
								{ id: "long", contextWindow: 1_500_000, label: "1.5M", apiModelSuffix: ":1m" },
							],
						},
					},
				}),
				mode: "act",
			})

			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())

			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: {
					create: standardCreate,
				},
				beta: {
					messages: {
						_client: {},
						create: vi.fn().mockResolvedValue(createAsyncIterable()),
					},
				},
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			expect(standardCreate)
			const requestBody = standardCreate.mock.calls[0][0] as { model: string; thinking: { type: string } }
			const requestOptions = standardCreate.mock.calls[0][1] as { headers: Record<string, string> }
			requestBody.model.should.equal("vendor-tiered:1m")
			expect(handler.getModel().info.capabilities?.contextWindow).to.equal(1_500_000)
			requestBody.thinking.should.deepEqual({ type: "adaptive" })
			requestOptions.should.deepEqual({
				headers: {
					"anthropic-beta": "context-1m-2025-08-07",
				},
			})
		})

		it.each([
			"claude-opus-5",
			"claude-sonnet-5",
		])("should send explicit disabled thinking when %s is configured with none", async (modelId) => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId,
					anthropic: { reasoning: { enableThinking: false, effort: "none" } },
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			expect(requestBody?.thinking).to.deep.equal({ type: "disabled" })
			expect(requestBody?.output_config).to.equal(undefined)
		})

		it("should keep Fable 5 adaptive thinking enabled when a stale profile requests none", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-fable-5",
					anthropic: { reasoning: { enableThinking: false, effort: "none" } },
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			expect(requestBody?.thinking).to.deep.equal({ type: "adaptive" })
			expect(requestBody?.output_config).to.equal(undefined)
		})

		it.each([
			{ configured: "omitted", expected: "omitted" },
			{ configured: "summarized", expected: "summarized" },
		])("should send thinking display $expected when the profile selects it", async ({ configured, expected }) => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-fable-5",
					anthropic: { reasoning: { display: configured } },
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			expect(requestBody?.thinking).to.deep.equal({ type: "adaptive", display: expected })
		})

		it.each([
			{ display: undefined },
			{ display: "" },
			{ display: "none" },
		])("should omit thinking display when the profile stores $display", async ({ display }) => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-fable-5",
					anthropic: { reasoning: { display } },
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			expect(requestBody?.thinking).to.deep.equal({ type: "adaptive" })
		})

		it("should send thinking display alongside a manual thinking budget", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-sonnet-4-5",
					modelInfo: { id: "claude-sonnet-4-5", capabilities: { supportsReasoning: true } },
					anthropic: { reasoning: { enableThinking: true, thinkingBudget: 2_048, display: "omitted" } },
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			expect(requestBody?.thinking).to.deep.equal({ type: "enabled", budget_tokens: 2_048, display: "omitted" })
		})

		it("should not attach a display to an explicitly disabled thinking config", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-opus-5",
					anthropic: { reasoning: { enableThinking: false, effort: "none", display: "omitted" } },
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			expect(requestBody?.thinking).to.deep.equal({ type: "disabled" })
		})

		it("should use adaptive thinking and output_config for Claude Opus adaptive models", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-opus-4-7",
					anthropic: { reasoning: { effort: "xhigh" } },
				}),
				mode: "act",
			})

			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())

			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: {
					create: standardCreate,
				},
				beta: {
					messages: {
						_client: {},
						create: vi.fn().mockResolvedValue(createAsyncIterable()),
					},
				},
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			expect(standardCreate)
			const requestBody = standardCreate.mock.calls[0][0] as {
				thinking: { type: string }
				output_config: { effort: string }
				temperature?: unknown
			}
			requestBody.should.have.property("thinking")
			requestBody.thinking.should.deepEqual({ type: "adaptive" })
			requestBody.should.have.property("output_config")
			requestBody.output_config.should.deepEqual({ effort: "xhigh" })
			should(requestBody.temperature).equal(undefined)
		})

		it("should use adaptive thinking and max effort for Claude Sonnet 4.6", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-sonnet-4-6",
					modelInfo: { id: "claude-sonnet-4-6", capabilities: { supportsReasoning: true } },
					anthropic: { reasoning: { effort: "max" } },
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			expect(requestBody?.thinking).to.deep.equal({ type: "adaptive" })
			expect(requestBody?.output_config).to.deep.equal({ effort: "max" })
		})

		it("should migrate legacy xhigh to max when the selected Anthropic model does not support xhigh", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-sonnet-4-6",
					anthropic: { reasoning: { effort: "xhigh" } },
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as Record<string, unknown> | undefined
			expect(requestBody?.output_config).to.deep.equal({ effort: "max" })
		})

		it("should use provider overrides for registry model request max tokens", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-opus-4-7",
					anthropic: {
						capabilities: {
							maxTokens: 12_345,
							supportsPromptCache: false,
						},
					},
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())

			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: {
					create: standardCreate,
				},
				beta: {
					messages: {
						_client: {},
						create: vi.fn().mockResolvedValue(createAsyncIterable()),
					},
				},
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as { max_tokens?: unknown } | undefined
			expect(requestBody?.max_tokens).to.equal(12_345)
		})

		it("uses the request-scoped compaction cap for Anthropic Messages", async () => {
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: "claude-opus-4-7",
					anthropic: { capabilities: { maxTokens: 12_345, supportsPromptCache: false } },
				}),
				mode: "act",
			})
			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: { create: standardCreate },
				beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(createAsyncIterable()) } },
			})

			const requestOptions: ApiRequestOptions = {
				generation: { purpose: "compaction", maxOutputTokens: 30_000 },
			}
			for await (const _chunk of handler.createMessage(
				"system prompt",
				[{ role: "user", content: "Hello" }],
				undefined,
				requestOptions,
			)) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as { max_tokens?: unknown } | undefined
			expect(requestBody?.max_tokens).to.equal(30_000)
		})

		it("should send the custom model id in Anthropic requests", async () => {
			const customModelId = "custom-claude-compatible-model"
			const handler = new AnthropicHandler({
				profile: ApiProfile.create({
					provider: "anthropic",
					apiKey: "test-api-key",
					modelId: customModelId,
					anthropic: {
						customModelEnabled: true,
						capabilities: {
							maxTokens: 12_345,
							contextWindow: 67_890,
							supportsImages: false,
							supportsPromptCache: false,
							supportsReasoning: false,
						},
						pricing: {
							inputPrice: 0.5,
							outputPrice: 1.5,
						},
					},
				}),
				mode: "act",
			})

			const standardCreate = vi.fn().mockResolvedValue(createAsyncIterable())

			vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
				messages: {
					create: standardCreate,
				},
				beta: {
					messages: {
						_client: {},
						create: vi.fn().mockResolvedValue(createAsyncIterable()),
					},
				},
			})

			for await (const _chunk of handler.createMessage("system prompt", [{ role: "user", content: "Hello" }])) {
			}

			const requestBody = standardCreate.mock.calls[0]?.[0] as { model?: unknown; max_tokens?: unknown } | undefined
			expect(requestBody?.model).to.equal(customModelId)
			expect(requestBody?.max_tokens).to.equal(12_345)
		})
	})
})
