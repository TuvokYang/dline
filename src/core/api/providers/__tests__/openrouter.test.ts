import "should"
import { ModelRegistry } from "@core/model-registry/ModelRegistry"
import { StateManager } from "@core/storage/StateManager"
import { openRouterDefaultModelInfo } from "@shared/api"
import { ModelInfo } from "@shared/proto/dline/models"
import { ApiProfile } from "@shared/proto/dline/profile"
import { Logger } from "@shared/services/Logger"
import axios from "axios"
import { afterEach, describe, expect, it, vi } from "vitest"
import { OpenRouterHandler } from "../openrouter"

vi.mock("axios", () => ({ default: { get: vi.fn() } }))

describe("OpenRouterHandler", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	const createAsyncIterable = (data: any[] = []) => ({
		[Symbol.asyncIterator]: async function* () {
			yield* data
		},
	})

	const tools = [{ type: "function", function: { name: "read_file", description: "", parameters: { type: "object" } } }] as any

	it("does not retry a missing generation record or log its Authorization header", async () => {
		const secret = "openrouter-generation-secret"
		const error = {
			isAxiosError: true,
			name: "AxiosError",
			message: "Request failed with status code 404",
			code: "ERR_BAD_REQUEST",
			config: { headers: { Authorization: `Bearer ${secret}` } },
			response: { status: 404 },
		}
		const get = vi.mocked(axios.get).mockRejectedValue(error)
		const loggerError = vi.spyOn(Logger, "error").mockImplementation(() => undefined)
		const loggerWarn = vi.spyOn(Logger, "warn").mockImplementation(() => undefined)
		const handler = new OpenRouterHandler({
			profile: ApiProfile.create({ provider: "openrouter", apiKey: secret }),
			mode: "act",
		})
		;(handler as any).lastGenerationId = "generation-404"

		const usage = await handler.getApiStreamUsage()

		expect(usage).toBeUndefined()
		get.mock.calls.length.should.equal(1)
		expect(loggerError.mock.calls.flat().join(" ")).not.toContain(secret)
		expect(loggerWarn.mock.calls.flat().join(" ")).toContain("404")
	})

	it("preserves effective false declarations instead of replacing them with catalog metadata", () => {
		const modelId = "anthropic/private"
		vi.spyOn(ModelRegistry, "getInstance").mockReturnValue({
			getProviderModels: () => ({
				models: { [modelId]: { capabilities: { thinking: { supported: true, mode: "effort" } } } },
			}),
		} as unknown as ModelRegistry)
		const profile = ApiProfile.create({
			provider: "openrouter",
			modelId,
			modelInfo: { id: modelId, capabilities: { thinking: { supported: false } } },
		})
		const handler = new OpenRouterHandler({ profile, mode: "act" })
		expect(handler.getModel().info.capabilities?.thinking?.supported).toBe(false)
	})

	it("uses the Profile model metadata when the dynamic OpenRouter cache is unavailable", () => {
		const profileModelInfo = ModelInfo.create({
			id: "vendor/native-1m-model",
			name: "Native 1M Model",
			capabilities: { contextWindow: 1_000_000, maxTokens: 128_000 },
		})
		vi.spyOn(StateManager, "get").mockReturnValue({
			getModelInfo: vi.fn().mockReturnValue(undefined),
		} as unknown as StateManager)
		const handler = new OpenRouterHandler({
			profile: ApiProfile.create({
				provider: "openrouter",
				modelId: "vendor/native-1m-model",
				modelInfo: profileModelInfo,
			}),
			mode: "act",
		})

		handler.getModel().should.deepEqual({
			id: "vendor/native-1m-model",
			info: profileModelInfo,
		})
	})

	it("passes an explicit profile disable through the complete gateway reasoning config", async () => {
		const profile = ApiProfile.create({
			provider: "openrouter",
			modelId: "private/opaque",
			modelInfo: {
				capabilities: { thinking: { supported: true, mode: "effort", defaultEnabled: true, effortLevels: ["low"] } },
			},
			openrouter: { reasoning: { enableThinking: false } },
		})
		const handler = new OpenRouterHandler({ profile, mode: "act" })
		const create = vi.fn().mockResolvedValue(createAsyncIterable())
		vi.spyOn(handler as any, "ensureClient").mockReturnValue({ chat: { completions: { create } } })
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
		}
		expect(create.mock.calls[0][0].reasoning).toEqual({ enabled: false })
		expect(create.mock.calls[0][0].include_reasoning).toBe(false)
	})

	it("should handle usage-only chunks when delta is missing", async () => {
		const handler = new OpenRouterHandler({
			profile: ApiProfile.create({ provider: "openrouter", apiKey: "test-api-key" }),
			mode: "act",
		})
		const fakeClient = {
			chat: {
				completions: {
					create: vi.fn().mockResolvedValue(
						createAsyncIterable([
							{
								choices: [{}],
								usage: {
									prompt_tokens: 13,
									completion_tokens: 5,
								},
							},
						]),
					),
				},
			},
		}
		vi.spyOn(handler as any, "ensureClient").mockReturnValue(fakeClient as any)
		vi.spyOn(handler, "getModel").mockReturnValue({
			id: "openai/gpt-4o-mini",
			info: openRouterDefaultModelInfo,
		})

		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
			chunks.push(chunk)
		}

		chunks.should.deepEqual([
			{
				type: "usage",
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				inputTokens: 13,
				outputTokens: 5,
				totalCost: 0,
			},
		])
	})

	it("should read cache_write_tokens from prompt_tokens_details", async () => {
		const handler = new OpenRouterHandler({
			profile: ApiProfile.create({ provider: "openrouter", apiKey: "test-api-key" }),
			mode: "act",
		})
		const fakeClient = {
			chat: {
				completions: {
					create: vi.fn().mockResolvedValue(
						createAsyncIterable([
							{
								choices: [{}],
								usage: {
									prompt_tokens: 1000,
									completion_tokens: 200,
									prompt_tokens_details: {
										cached_tokens: 500,
										cache_write_tokens: 300,
									},
								},
							},
						]),
					),
				},
			},
		}
		vi.spyOn(handler as any, "ensureClient").mockReturnValue(fakeClient as any)
		vi.spyOn(handler, "getModel").mockReturnValue({
			id: "anthropic/claude-sonnet-4.6",
			info: openRouterDefaultModelInfo,
		})

		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
			chunks.push(chunk)
		}

		chunks.should.deepEqual([
			{
				type: "usage",
				cacheWriteTokens: 300,
				cacheReadTokens: 500,
				inputTokens: 200,
				outputTokens: 200,
				totalCost: 0,
			},
		])
	})

	type ParallelToolCallsTestCase = {
		modelId: string
		enableParallelToolCalling: boolean
		expectedParallelToolCalls: boolean
	}

	const parallelToolCallsTestCases: ParallelToolCallsTestCase[] = [
		{
			modelId: "openai/gpt-4o-mini",
			enableParallelToolCalling: true,
			expectedParallelToolCalls: true,
		},
		{
			modelId: "openai/gpt-4o-mini",
			enableParallelToolCalling: false,
			expectedParallelToolCalls: false,
		},
		{
			modelId: "google/gemini-3-flash-preview",
			enableParallelToolCalling: true,
			expectedParallelToolCalls: true,
		},
	]

	for (const testCase of parallelToolCallsTestCases) {
		const settingLabel = testCase.enableParallelToolCalling ? "enabled" : "disabled"
		it(`should set parallel_tool_calls=${testCase.expectedParallelToolCalls} for ${testCase.modelId} when setting is ${settingLabel}`, async () => {
			const handler = new OpenRouterHandler({
				profile: ApiProfile.create({ provider: "openrouter", apiKey: "test-api-key" }),
				mode: "act",
				enableParallelToolCalling: testCase.enableParallelToolCalling,
			})
			const createStub = vi.fn().mockResolvedValue(createAsyncIterable([]))
			const fakeClient = {
				chat: {
					completions: {
						create: createStub,
					},
				},
			}
			vi.spyOn(handler as any, "ensureClient").mockReturnValue(fakeClient as any)
			vi.spyOn(handler, "getModel").mockReturnValue({
				id: testCase.modelId,
				info: openRouterDefaultModelInfo,
			})

			for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], tools)) {
				// drain stream
			}

			const payload = createStub.mock.calls[0][0]
			payload.parallel_tool_calls.should.equal(testCase.expectedParallelToolCalls)
		})
	}
})
