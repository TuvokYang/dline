import { LiteLlmHandler, type LiteLlmModelInfoResponse } from "@core/api/providers/litellm"
import { convertToOpenAiMessages } from "@core/api/transform/openai-format"
import { ModelRegistry } from "@core/model-registry/ModelRegistry" // used in getModel tests
import { liteLlmDefaultModelId } from "@shared/api"
import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiProfile } from "@shared/proto/dline/profile"
import { expect } from "chai"
import { afterEach, beforeEach, describe, it, vi } from "vitest"
import { ClineStorageMessage } from "@/shared/messages/content"
import { mockFetchForTesting } from "@/shared/net"

const fakeClient = {
	chat: {
		completions: {
			create: vi.fn(),
		},
	},
	baseURL: "https://fake.example",
}

describe("LiteLlmHandler", () => {
	const mockFetch = vi.fn()
	let doneMockingFetch: (value: any) => void = () => {}

	const mockModelFetch = (modelInfo: LiteLlmModelInfoResponse["data"][number]) => {
		mockFetch.mockResolvedValue({
			ok: true,
			json: () =>
				Promise.resolve({
					data: [modelInfo],
				}),
		})
	}

	let handler: LiteLlmHandler

	const mockHandlerChat = () => {
		vi.spyOn(handler, "ensureClient" as any).mockReturnValue(fakeClient)
	}

	const initializeHandler = (model: string) => {
		handler = new LiteLlmHandler({
			profile: ApiProfile.create({
				provider: "litellm",
				apiKey: "test-api-key",
				baseUrl: "http://localhost:4000",
				modelId: model,
				litellm: { usePromptCache: true } as any,
			}),
			mode: "act",
		})

		mockHandlerChat()
	}

	beforeEach(() => {
		fakeClient.chat.completions.create.mockClear()

		mockFetchForTesting(mockFetch, () => {
			return new Promise((resolve) => {
				doneMockingFetch = resolve
			})
		})

		// Configure the stub to return a stream that closes immediately with usage data
		fakeClient.chat.completions.create.mockResolvedValue(
			createAsyncIterable([
				{
					choices: [{ delta: { content: "test response" } }],
				},
				{
					choices: [{}],
					usage: {
						prompt_tokens: 100,
						completion_tokens: 50,
						cache_creation_input_tokens: 20,
						cache_read_input_tokens: 10,
					},
				},
			]),
		)
	})

	afterEach(() => {
		// sinon.reset removed
		doneMockingFetch(void 0)
	})

	const createAsyncIterable = (data: any[] = []) => {
		return {
			[Symbol.asyncIterator]: async function* () {
				yield* data
			},
		}
	}

	describe("prompt cache", () => {
		const setModelData = (model: string, supportsPromptCaching: boolean) => {
			mockModelFetch({
				model_name: model,
				litellm_params: {
					model,
				},
				model_info: {
					supports_prompt_caching: supportsPromptCaching,
					input_cost_per_token: 0.01,
					output_cost_per_token: 0.02,
				},
			})
		}

		describe("when the model doesn't support prompt caching", () => {
			const model = "openai/gpt-5"

			beforeEach(() => {
				initializeHandler(model)
				setModelData(model, false)
			})

			it("sends the system prompt and messages with the openai format", async () => {
				const systemPrompt = "Test System Prompt"
				const messages: ClineStorageMessage[] = [
					{
						role: "user",
						content: "first message",
					},
					{
						role: "assistant",
						content: "first response",
					},
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "test",
							},
							{
								type: "text",
								text: "second message",
							},
						],
					},
				]

				for await (const _ of handler.createMessage(systemPrompt, messages)) {
				}

				const callArgs = fakeClient.chat.completions.create.mock.calls[0][0]

				const systemPromptMessage = callArgs.messages.shift()
				expect(systemPromptMessage).to.deep.equal({
					role: "system",
					content: systemPrompt,
				})

				expect(callArgs.messages).to.deep.equal(convertToOpenAiMessages(messages))
			})
		})

		describe("when the model supports prompt caching", () => {
			const model = "anthropic/claude-sonnet-4-20250514"

			beforeEach(() => {
				initializeHandler(model)

				setModelData(model, true)
			})

			it("inserts the cache control in the system prompt and the last two user messages", async () => {
				const systemPrompt = "Test System Prompt"
				const messages: ClineStorageMessage[] = [
					{
						role: "user",
						content: "first message",
					},
					{
						role: "assistant",
						content: "first response",
					},
					{
						role: "user",
						content: [
							{
								type: "text",
								text: "test",
							},
							{
								type: "text",
								text: "second message",
							},
						],
					},
				]

				for await (const _ of handler.createMessage(systemPrompt, messages)) {
				}

				const callArgs = fakeClient.chat.completions.create.mock.calls[0][0]

				expect(callArgs.messages[0]).to.deep.equal({
					role: "system",
					content: [
						{
							text: systemPrompt,
							type: "text",
							cache_control: {
								type: "ephemeral",
							},
						},
					],
				})

				const sentMessages = callArgs.messages
				expect(sentMessages.length).to.equal(4)

				const firstUserMessage = sentMessages[1]

				expect(firstUserMessage).to.deep.equal({
					role: "user",
					content: [
						{
							type: "text",
							text: "first message",
							cache_control: {
								type: "ephemeral",
							},
						},
					],
				})

				const lastUserMessage = sentMessages[3]
				expect(lastUserMessage.content[0]).to.deep.equal({
					type: "text",
					text: "test",
				})

				const lastContentBlock = lastUserMessage.content[lastUserMessage.content.length - 1]
				expect(lastContentBlock).to.deep.equal({
					type: "text",
					text: "second message",
					cache_control: {
						type: "ephemeral",
					},
				})

				expect(callArgs.model).to.be.a("string")
				expect(callArgs.stream).to.equal(true)
				expect(callArgs.stream_options).to.deep.equal({ include_usage: true })
			})
		})
	})

	describe("runtime identity requests", () => {
		it.each([
			"openai/opaque-upstream",
			"anthropic/opaque-upstream",
		])("uses profile-carried identity for the request, reasoning and usage with %s", async (upstream) => {
			const id = "carried-public-deployment"
			const anthropicRoute = upstream.startsWith("anthropic/")
			handler = new LiteLlmHandler({
				profile: ApiProfile.create({
					provider: "litellm",
					modelInfo: {
						id,
						capabilities: {
							thinking: anthropicRoute
								? { supported: true, mode: "budget", minBudget: 17, maxBudget: 101 }
								: {
										supported: true,
										mode: "effort",
										effortLevels: ["low"],
										defaultEnabled: true,
										defaultEffort: "low",
									},
						},
					},
					litellm: { reasoning: { thinkingBudget: 3 } },
				}),
				mode: "act",
			})
			mockHandlerChat()
			mockModelFetch({
				model_name: id,
				litellm_params: { model: upstream },
				model_info: { input_cost_per_token: 0.01, output_cost_per_token: 0.02 },
			})
			const chunks = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hello" }])) {
				chunks.push(chunk)
			}

			const body = fakeClient.chat.completions.create.mock.calls[0][0]
			expect(body.model).to.equal(id)
			expect(body.thinking).to.deep.equal(anthropicRoute ? { type: "enabled", budget_tokens: 17 } : undefined)
			expect(body.reasoning_effort).to.equal(anthropicRoute ? undefined : "low")
			expect(body.drop_params).to.equal(true)
			expect(chunks).to.deep.equal([
				{ type: "text", text: "test response" },
				{ type: "usage", inputTokens: 100, outputTokens: 50, cacheWriteTokens: 20, cacheReadTokens: 10, totalCost: 1.9 },
			])
		})

		it.each([
			"openai/opaque-upstream",
			"anthropic/opaque-upstream",
		])("rejects another identity's reasoning declaration with %s", async (upstream) => {
			const id = "explicit-unknown-deployment"
			const anthropicRoute = upstream.startsWith("anthropic/")
			handler = new LiteLlmHandler({
				profile: ApiProfile.create({
					provider: "litellm",
					modelId: id,
					modelInfo: {
						id: "another-deployment",
						capabilities: {
							thinking: anthropicRoute
								? { supported: true, mode: "budget", minBudget: 17, maxBudget: 101 }
								: { supported: true, mode: "effort", effortLevels: ["low"] },
						},
					},
					litellm: { reasoning: { thinkingBudget: 23, effort: "low" } },
				}),
				mode: "act",
			})
			mockHandlerChat()
			mockModelFetch({
				model_name: id,
				litellm_params: { model: upstream },
				model_info: { input_cost_per_token: 0, output_cost_per_token: 0 },
			})
			const registry = vi.spyOn(ModelRegistry, "getInstance").mockReturnValue({
				getProviderModels: () => ({ models: {} }),
			} as unknown as ModelRegistry)
			try {
				for await (const _ of handler.createMessage("system", [])) {
				}
				const body = fakeClient.chat.completions.create.mock.calls[0][0]
				expect(body.model).to.equal(id)
				expect(body.thinking).to.equal(undefined)
				expect(body.reasoning_effort).to.equal(undefined)
				expect(body.output_config).to.equal(undefined)
				expect(handler.getModel()).to.deep.equal({ id, info: { id } })
			} finally {
				registry.mockRestore()
			}
		})

		it("uses only the selected catalog entry when directly constructed without final metadata", async () => {
			const id = "selected-public-deployment"
			const catalogInfo: ModelInfo = {
				id,
				capabilities: {
					thinking: {
						supported: true,
						mode: "effort",
						effortLevels: ["low"],
						defaultEnabled: true,
						defaultEffort: "low",
					},
				},
			}
			initializeHandler(id)
			mockModelFetch({
				model_name: id,
				litellm_params: { model: "openai/opaque-upstream" },
				model_info: { input_cost_per_token: 0, output_cost_per_token: 0 },
			})
			const registry = vi.spyOn(ModelRegistry, "getInstance").mockReturnValue({
				getProviderModels: () => ({ models: { [id]: catalogInfo } }),
			} as unknown as ModelRegistry)
			try {
				for await (const _ of handler.createMessage("system", [])) {
				}
				const body = fakeClient.chat.completions.create.mock.calls[0][0]
				expect(body.model).to.equal(id)
				expect(body.reasoning_effort).to.equal("low")
				expect(handler.getModel().info).to.equal(catalogInfo)
			} finally {
				registry.mockRestore()
			}
		})
	})

	describe("getModel", () => {
		let registryStub: ReturnType<typeof vi.spyOn>

		const stubCatalog = (models: Record<string, unknown>) => {
			registryStub.mockReturnValue({
				getProviderModels: (providerId: string) => (providerId === "litellm" ? { models } : undefined),
			} as any)
		}

		beforeEach(() => {
			registryStub = vi.spyOn(ModelRegistry, "getInstance")
			stubCatalog({})
		})

		afterEach(() => {
			registryStub.mockRestore()
		})

		it("keeps unknown selections minimal and aligns the unselected default identity", () => {
			const unknown = new LiteLlmHandler({
				profile: ApiProfile.create({ provider: "litellm", apiKey: "test", modelId: "some-model" }),
				mode: "act",
			})
			expect(unknown.getModel()).to.deep.equal({ id: "some-model", info: { id: "some-model" } })
			const unselected = new LiteLlmHandler({ profile: ApiProfile.create({ provider: "litellm" }), mode: "act" })
			expect(unselected.getModel().id).to.equal(liteLlmDefaultModelId)
			expect(unselected.getModel().info.id).to.equal(liteLlmDefaultModelId)
		})

		it("returns user-configured model info when liteLlmModelInfo is provided and the catalog has no entry", () => {
			const h = new LiteLlmHandler({
				profile: ApiProfile.create({
					provider: "litellm",
					apiKey: "test",
					modelId: "claude-sonnet-4-6",
					modelInfo: {
						id: "claude-sonnet-4-6",
						capabilities: {
							contextWindow: 1_000_000,
							maxTokens: 8192,
							supportsImages: true,
							supportsPromptCache: true,
						},
						pricing: { inputPrice: 3, outputPrice: 15, cacheWritesPrice: 3.75, cacheReadsPrice: 0.3 },
					} as any,
				}),
				mode: "act",
			})
			const model = h.getModel()
			expect(model.id).to.equal("claude-sonnet-4-6")
			expect(model.info?.capabilities?.contextWindow).to.equal(1_000_000)
		})

		it("preserves final runtime metadata instead of rereading and replacing it from the catalog", () => {
			const catalogInfo = {
				id: "claude-sonnet-4-6",
				capabilities: { contextWindow: 200_000, maxTokens: 4096, supportsImages: true, supportsPromptCache: true },
				pricing: { inputPrice: 0, outputPrice: 0 },
			}
			stubCatalog({ "claude-sonnet-4-6": catalogInfo })

			const h = new LiteLlmHandler({
				profile: ApiProfile.create({
					provider: "litellm",
					apiKey: "test",
					modelId: "claude-sonnet-4-6",
					modelInfo: {
						id: "claude-sonnet-4-6",
						capabilities: {
							contextWindow: 1_000_000,
							maxTokens: 8192,
							supportsImages: true,
							supportsPromptCache: true,
						},
						pricing: { inputPrice: 3, outputPrice: 15, cacheWritesPrice: 3.75, cacheReadsPrice: 0.3 },
					} as any,
				}),
				mode: "act",
			})
			const model = h.getModel()
			expect(model.info?.capabilities?.contextWindow).to.equal(1_000_000)
			expect(model.info).not.to.equal(catalogInfo)
		})
	})
})
