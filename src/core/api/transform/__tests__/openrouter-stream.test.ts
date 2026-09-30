import type { ModelInfo } from "@shared/api"
import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import should from "should"
import { describe, expect, it, vi } from "vitest"
import { createOpenRouterStream } from "../openrouter-stream"
import { createVercelAIGatewayStream } from "../vercel-ai-gateway-stream"

describe.each(["openrouter", "vercel"] as const)("%s effective reasoning payload", (provider) => {
	const cases: {
		name: string
		modelId: string
		capabilities: ModelCapabilities
		config: ReasoningConfig
		payload?: unknown
		verbosity?: string
	}[] = [
		{
			name: "missing declaration",
			modelId: "anthropic/claude-opus-5-5",
			capabilities: { supportsReasoning: true },
			config: { effort: "high", thinkingBudget: 1600 },
		},
		{
			name: "explicit false",
			modelId: "anthropic/claude-opus-5-5",
			capabilities: { thinking: { supported: false, mode: "effort" } },
			config: { effort: "high" },
		},
		{
			name: "declared budget",
			modelId: "anthropic/claude-opus-5-5",
			capabilities: { thinking: { supported: true, mode: "budget", maxBudget: 1200 } },
			config: { thinkingBudget: 1600 },
			payload: { max_tokens: 1200 },
		},
		{
			name: "default effort",
			modelId: "private/opaque",
			capabilities: {
				thinking: { supported: true, mode: "effort", defaultEnabled: true, defaultEffort: "low", effortLevels: ["low"] },
			},
			config: {},
			payload: { effort: "low" },
		},
		{
			name: "required stale disable",
			modelId: "anthropic/private",
			capabilities: { thinking: { supported: true, mode: "effort", canDisable: false, effortLevels: ["low"] } },
			config: { enableThinking: false, effort: "none" },
			payload: { enabled: true },
		},
		{
			name: "illegal effort",
			modelId: "anthropic/private",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: [] } },
			config: { effort: "medium" },
			payload: { enabled: true },
		},
		{
			name: "declared Anthropic alias",
			modelId: "anthropic/private",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["max"] } },
			config: { effort: "ultra" },
			payload: { enabled: true },
			verbosity: "max",
		},
	]
	it.each(cases)("encodes $name independently of model-name capability rules", async ({
		modelId,
		capabilities,
		config,
		payload,
		verbosity,
	}) => {
		const create = vi.fn().mockResolvedValue((async function* () {})())
		const client = { chat: { completions: { create } } }
		const model = { id: modelId, info: { id: modelId, capabilities } }
		if (provider === "openrouter") {
			await createOpenRouterStream(
				client as never,
				"system",
				[{ role: "user", content: "hi" }],
				model,
				config.effort,
				config.thinkingBudget,
				undefined,
				undefined,
				undefined,
				config,
			)
		} else {
			await createVercelAIGatewayStream(
				client as never,
				"system",
				[{ role: "user", content: "hi" }],
				model,
				config.effort,
				config.thinkingBudget,
				undefined,
				config,
			)
		}
		const body = create.mock.calls[0][0]
		expect(body.model).toBe(modelId)
		expect(body.reasoning).toEqual(provider === "vercel" && verbosity ? { enabled: true, effort: verbosity } : payload)
		expect(body.verbosity).toBe(provider === "openrouter" ? verbosity : undefined)
		expect(body.include_reasoning).toBe(payload !== undefined)
	})
})

describe("createOpenRouterStream", () => {
	const createAsyncIterable = () => ({
		async *[Symbol.asyncIterator]() {},
	})

	const createClient = () => {
		const create = vi.fn().mockResolvedValue(createAsyncIterable())
		return {
			client: {
				chat: {
					completions: {
						create,
					},
				},
			},
			create,
		}
	}

	const createModelInfo = (maxTokens: number): ModelInfo => ({
		id: "test-model",
		capabilities: { maxTokens, contextWindow: 1_048_576, supportsImages: true, supportsPromptCache: false },
	})

	it("caps Gemini Flash OpenRouter requests to 8192 max_tokens", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(client as any, "system prompt", [{ role: "user", content: "hello" }] as any, {
			id: "google/gemini-2.5-flash",
			info: createModelInfo(65_536),
		})

		const payload = create.mock.calls[0][0] as Record<string, any>
		payload.should.have.property("max_tokens", 8_192)
	})

	it("keeps lower Gemini Flash max_tokens values when already below 8192", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(client as any, "system prompt", [{ role: "user", content: "hello" }] as any, {
			id: "google/gemini-2.5-flash",
			info: createModelInfo(4_096),
		})

		const payload = create.mock.calls[0][0] as Record<string, any>
		payload.should.have.property("max_tokens", 4_096)
	})

	it("does not send max_tokens for non-Gemini models", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(client as any, "system prompt", [{ role: "user", content: "hello" }] as any, {
			id: "anthropic/claude-sonnet-4.5",
			info: createModelInfo(64_000),
		})

		const payload = create.mock.calls[0][0] as any
		payload.should.not.have.property("max_tokens")
	})

	it("does not send max_tokens for non-Flash Gemini models", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(client as any, "system prompt", [{ role: "user", content: "hello" }] as any, {
			id: "google/gemini-2.5-pro",
			info: createModelInfo(65_536),
		})

		const payload = create.mock.calls[0][0] as any
		payload.should.not.have.property("max_tokens")
	})

	it("adds cache_control blocks for Qwen models that require explicit OpenRouter caching", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(client as any, "system prompt", [{ role: "user", content: "hello" }] as any, {
			id: "qwen/qwen3.6-plus",
			info: createModelInfo(65_536),
		})

		const payload = create.mock.calls[0][0] as any
		payload.messages[0].content[0].cache_control.should.deepEqual({ type: "ephemeral" })
		payload.messages[1].content[0].cache_control.should.deepEqual({ type: "ephemeral" })
	})

	it("uses declared Anthropic adaptive reasoning with the OpenRouter verbosity mapping", async () => {
		const { client, create } = createClient()

		await createOpenRouterStream(
			client as any,
			"system prompt",
			[{ role: "user", content: "hello" }] as any,
			{
				id: "anthropic/private-deployment",
				info: {
					id: "anthropic/private-deployment",
					capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["xhigh"] } },
				},
			},
			"xhigh",
		)

		const payload = create.mock.calls[0][0] as any
		payload.should.have.property("reasoning")
		payload.reasoning.should.deepEqual({ enabled: true })
		payload.should.have.property("verbosity", "xhigh")
		should(payload.temperature).equal(undefined)
		should(payload.top_p).equal(undefined)
	})
})
