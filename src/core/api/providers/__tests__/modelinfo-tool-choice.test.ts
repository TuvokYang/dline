import { QwenApiRegions } from "@shared/api"
import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { describe, expect, it, vi } from "vitest"
import { AnthropicHandler } from "../anthropic"
import { AskSageHandler } from "../asksage"
import { BasetenHandler } from "../baseten"
import { AwsBedrockHandler } from "../bedrock"
import { CerebrasHandler } from "../cerebras"
import { DoubaoHandler } from "../doubao"
import { FireworksHandler } from "../fireworks"
import { GroqHandler } from "../groq"
import { HicapHandler } from "../hicap"
import { HuaweiCloudMaaSHandler } from "../huawei-cloud-maas"
import { HuggingFaceHandler } from "../huggingface"
import { LiteLlmHandler } from "../litellm"
import { LmStudioHandler } from "../lmstudio"
import { MinimaxHandler } from "../minimax"
import { MistralHandler } from "../mistral"
import { MoonshotHandler } from "../moonshot"
import { NebiusHandler } from "../nebius"
import { NousResearchHandler } from "../nousresearch"
import { OllamaHandler } from "../ollama"
import { QwenHandler } from "../qwen"
import { QwenCodeHandler } from "../qwen-code"
import { RequestyHandler } from "../requesty"
import { SambanovaHandler } from "../sambanova"
import { TogetherHandler } from "../together"
import { VertexHandler } from "../vertex"
import { WandbHandler } from "../wandb"
import { XAIHandler } from "../xai"
import { ZAiHandler } from "../zai"

const runtimeModelHandlers = [
	{ provider: "baseten", Handler: BasetenHandler },
	{ provider: "bedrock", Handler: AwsBedrockHandler },
	{ provider: "asksage", Handler: AskSageHandler },
	{ provider: "doubao", Handler: DoubaoHandler },
	{ provider: "fireworks", Handler: FireworksHandler },
	{ provider: "moonshot", Handler: MoonshotHandler },
	{ provider: "nebius", Handler: NebiusHandler },
	{ provider: "nousResearch", Handler: NousResearchHandler },
	{ provider: "qwen-code", Handler: QwenCodeHandler },
	{ provider: "sambanova", Handler: SambanovaHandler },
	{ provider: "xai", Handler: XAIHandler },
	{ provider: "zai", Handler: ZAiHandler },
	{ provider: "cerebras", Handler: CerebrasHandler },
	{ provider: "huggingface", Handler: HuggingFaceHandler },
	{ provider: "together", Handler: TogetherHandler },
	{ provider: "groq", Handler: GroqHandler },
	{ provider: "hicap", Handler: HicapHandler },
	{ provider: "huawei-cloud-maas", Handler: HuaweiCloudMaaSHandler },
	{ provider: "mistral", Handler: MistralHandler },
	{ provider: "requesty", Handler: RequestyHandler },
	{ provider: "vertex", Handler: VertexHandler },
	{ provider: "wandb", Handler: WandbHandler },
	{ provider: "lmstudio", Handler: LmStudioHandler },
	{ provider: "ollama", Handler: OllamaHandler },
]

describe.each(runtimeModelHandlers)("$provider final runtime metadata", ({ provider, Handler }) => {
	it("preserves the complete matching declaration without mutation", () => {
		const id =
			new Handler({ profile: ApiProfile.create({ provider, apiKey: "test-api-key" }), mode: "act" }).getModel().id ||
			"opaque-effective-test"
		const profile = ApiProfile.create({
			provider,
			apiKey: "test-api-key",
			modelId: id,
			modelInfo: {
				id,
				name: "Effective custom model",
				userDefined: true,
				apiFormats: [],
				pricing: { inputPrice: 0, outputPrice: 0 },
				capabilities: {
					maxTokens: 0,
					contextWindow: 71,
					supportsReasoning: false,
					supportsTools: false,
					tools: [],
					thinking: {
						supported: false,
						mode: "budget",
						minBudget: 0,
						maxBudget: 0,
						effortLevels: [],
						defaultEnabled: false,
						canDisable: false,
					},
				},
			},
			lmstudio: { lmStudioNumCtx: "71" },
			ollama: { ollamaApiOptionsCtxNum: "71" },
		})
		const before = JSON.stringify(profile)
		const model = new Handler({ profile, mode: "act" }).getModel()
		expect(model).toEqual({ id: profile.modelId, info: profile.modelInfo })
		expect(JSON.stringify(profile)).toBe(before)
	})

	it("does not borrow a stale/default declaration for an explicit unknown id", () => {
		const profile = ApiProfile.create({
			provider,
			apiKey: "test-api-key",
			modelId: "opaque-unknown-test",
			modelInfo: { id: "another-model", capabilities: { thinking: { supported: true, mode: "budget" } } },
			lmstudio: { lmStudioNumCtx: "71" },
			ollama: { ollamaApiOptionsCtxNum: "71" },
		})
		const model = new Handler({ profile, mode: "act" }).getModel()
		const info =
			provider === "lmstudio" || provider === "ollama"
				? { id: "opaque-unknown-test", capabilities: { contextWindow: 71 } }
				: { id: "opaque-unknown-test" }
		expect(model).toEqual({ id: "opaque-unknown-test", info })
	})
})

it("Anthropic does not borrow stale thinking metadata for an explicit unknown ID", async () => {
	const id = "opaque-anthropic-unknown"
	const handler = new AnthropicHandler({
		profile: ApiProfile.create({
			provider: "anthropic",
			apiKey: "test-api-key",
			modelId: id,
			modelInfo: {
				id: "another-model",
				capabilities: { thinking: { supported: true, mode: "budget", maxBudget: 2048 } },
			},
			anthropic: { reasoning: { thinkingBudget: 1024 } },
		}),
		mode: "act",
	})
	const create = vi.fn().mockResolvedValue((async function* () {})())
	Object.defineProperty(handler, "ensureClient", { value: () => ({ messages: { create } }) })
	for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
	}
	expect(create.mock.calls[0][0].model).toBe(id)
	expect(create.mock.calls[0][0].thinking).toBeUndefined()
	expect(handler.getModel().info.capabilities?.thinking).toBeUndefined()
})

it.each([
	LmStudioHandler,
	OllamaHandler,
])("local context overlay does not mutate model capabilities or another instance", (Handler) => {
	const profile = ApiProfile.create({
		provider: Handler === LmStudioHandler ? "lmstudio" : "ollama",
		modelId: "local-test",
		modelInfo: { id: "local-test", capabilities: { contextWindow: 11, thinking: { supported: false } } },
		lmstudio: { lmStudioNumCtx: "23" },
		ollama: { ollamaApiOptionsCtxNum: "23" },
	})
	const first = new Handler({ profile, mode: "act" }).getModel()
	const second = new Handler({
		profile: ApiProfile.create({ ...profile, lmstudio: { lmStudioNumCtx: "31" }, ollama: { ollamaApiOptionsCtxNum: "31" } }),
		mode: "act",
	}).getModel()
	expect(first.info.capabilities?.contextWindow).toBe(23)
	expect(second.info.capabilities?.contextWindow).toBe(31)
	expect(first.info.capabilities?.thinking).toEqual(profile.modelInfo?.capabilities?.thinking)
	expect(profile.modelInfo?.capabilities?.contextWindow).toBe(11)
})

it.each([
	{ provider: "fireworks", Handler: FireworksHandler },
	{ provider: "together", Handler: TogetherHandler },
	{ provider: "hicap", Handler: HicapHandler },
	{ provider: "xai", Handler: XAIHandler },
])("$provider sends the resolved selection without adding a new reasoning wire", async ({ provider, Handler }) => {
	const profile = ApiProfile.create({
		provider,
		apiKey: "test-api-key",
		modelInfo: {
			id: "opaque-wire-test",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["high"] } },
		},
		xai: { reasoning: { effort: "high" } },
	})
	const handler = new Handler({ profile, mode: "act" })
	const create = vi.fn().mockResolvedValue((async function* () {})())
	Object.defineProperty(handler, "ensureClient", { value: () => ({ chat: { completions: { create } } }) })
	for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
	}
	expect(create.mock.calls[0][0].model).toBe("opaque-wire-test")
	expect(create.mock.calls[0][0].reasoning_effort).toBeUndefined()
})

it("Ollama sends the same local context as the preserved model projection", async () => {
	const profile = ApiProfile.create({
		provider: "ollama",
		modelInfo: { id: "local-wire-test", capabilities: { thinking: { supported: false } } },
		ollama: { ollamaApiOptionsCtxNum: "23" },
	})
	const handler = new OllamaHandler({ profile, mode: "act" })
	const chat = vi.fn().mockResolvedValue((async function* () {})())
	Object.defineProperty(handler, "ensureClient", { value: () => ({ chat, abort: vi.fn() }) })
	for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
	}
	expect(chat.mock.calls[0][0]).toMatchObject({ model: "local-wire-test", options: { num_ctx: 23 } })
	expect(handler.getModel().info.capabilities).toEqual({ ...profile.modelInfo?.capabilities, contextWindow: 23 })
})

const qwenBudgetCases: {
	name: string
	capabilities?: ModelCapabilities
	overrides?: ModelCapabilities
	modelInfoId?: string
	reasoning?: ReasoningConfig
	enable?: boolean
	budget?: number
}[] = [
	{ name: "missing support", reasoning: { thinkingBudget: 23 } },
	{ name: "unknown default", capabilities: { thinking: { supported: true, mode: "budget" } } },
	{
		name: "partial effective minimum override",
		capabilities: { thinking: { supported: true, mode: "budget", minBudget: 9, maxBudget: 101 } },
		overrides: { thinking: { minBudget: 17 } },
		reasoning: { thinkingBudget: 3 },
		enable: true,
		budget: 17,
	},
	{
		name: "stale complete metadata",
		modelInfoId: "another-model",
		capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17 } },
		reasoning: { thinkingBudget: 23 },
	},
	{ name: "coarse support only", capabilities: { supportsReasoning: true }, reasoning: { thinkingBudget: 23 } },
	{
		name: "explicit false",
		capabilities: { thinking: { supported: false, mode: "budget" } },
		reasoning: { thinkingBudget: 23 },
	},
	{ name: "missing mode", capabilities: { thinking: { supported: true, maxBudget: 101 } }, reasoning: { thinkingBudget: 23 } },
	{
		name: "positive minimum",
		capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17, maxBudget: 101 } },
		reasoning: { thinkingBudget: 3 },
		enable: true,
		budget: 17,
	},
	{
		name: "invalid bounds",
		capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17, maxBudget: 11 } },
		reasoning: { thinkingBudget: 3 },
	},
	{
		name: "optional zero disable",
		capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17, defaultEnabled: true } },
		reasoning: { thinkingBudget: 0 },
		enable: false,
	},
	{
		name: "required zero inherits",
		capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17, canDisable: false } },
		reasoning: { thinkingBudget: 0 },
		enable: true,
	},
	{
		name: "declared default without numeric preference",
		capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17, defaultEnabled: true } },
		enable: true,
	},
	{
		name: "fractional budget",
		capabilities: { thinking: { supported: true, mode: "budget" } },
		reasoning: { thinkingBudget: 1.5 },
	},
]

describe.each([QwenApiRegions.CHINA, QwenApiRegions.INTERNATIONAL])("Qwen %s declared budget requests", (qwenApiLine) => {
	it.each(qwenBudgetCases)("encodes $name without replacing an opaque model", async ({
		capabilities,
		overrides,
		modelInfoId,
		reasoning,
		enable,
		budget,
	}) => {
		const id = "qwen3-opaque-alias"
		const handler = new QwenHandler({
			profile: ApiProfile.create({
				provider: "qwen",
				modelId: id,
				modelInfo: { id: modelInfoId ?? id, capabilities },
				qwen: { qwenApiLine, reasoning, capabilities: overrides },
			}),
			mode: "act",
		})
		const create = vi.fn().mockResolvedValue((async function* () {})())
		;(handler as unknown as { client: unknown }).client = { chat: { completions: { create } } }
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
		}
		const body = create.mock.calls[0][0]
		expect(body.model).toBe(id)
		expect(body.enable_thinking).toBe(enable)
		expect(body.thinking_budget).toBe(budget)
	})
})

describe.each(["requesty", "litellm"] as const)("%s upstream reasoning conversion", (provider) => {
	it.each([
		{
			name: "missing mode",
			capabilities: { supportsReasoning: true },
			upstream: "anthropic/claude-opus-5-5",
			thinking: undefined,
		},
		{
			name: "explicit false",
			capabilities: { thinking: { supported: false, mode: "effort" } },
			upstream: "anthropic/claude-opus-5-5",
			thinking: undefined,
		},
		{
			name: "declared budget",
			capabilities: { thinking: { supported: true, mode: "budget", maxBudget: 1200 } },
			upstream: "anthropic/claude-opus-5-5",
			thinking: { type: "enabled", budget_tokens: 1200 },
		},
		{
			name: "opaque non-Anthropic upstream",
			capabilities: { thinking: { supported: true, mode: "budget" } },
			upstream: "openai/private",
			thinking: undefined,
		},
	])("encodes $name without capability inference from public aliases", async ({ capabilities, upstream, thinking }) => {
		const modelId = provider === "requesty" ? upstream : "claude-opus-5-5-misleading-alias"
		const profile = ApiProfile.create({
			provider,
			modelId,
			modelInfo: { id: modelId, name: "Effective alias", capabilities },
			requesty: provider === "requesty" ? { reasoning: { thinkingBudget: 1600 } } : undefined,
			litellm: provider === "litellm" ? { reasoning: { thinkingBudget: 1600 } } : undefined,
		})
		const handler =
			provider === "requesty" ? new RequestyHandler({ profile, mode: "act" }) : new LiteLlmHandler({ profile, mode: "act" })
		const create = vi.fn().mockResolvedValue((async function* () {})())
		;(handler as unknown as { client: unknown }).client = { chat: { completions: { create } } }
		if (provider === "litellm") {
			;(handler as unknown as { fetchModelsInfo: () => Promise<unknown> }).fetchModelsInfo = async () => ({
				data: [{ model_name: modelId, litellm_params: { model: upstream }, model_info: {} }],
			})
		}
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
		}
		const body = create.mock.calls[0][0]
		expect(body.model).toBe(modelId)
		expect(body.thinking).toEqual(thinking)
		expect(body.output_config).toBeUndefined()
	})

	it.each([
		{
			name: "declared default",
			thinking: { supported: true, mode: "effort", effortLevels: ["low"], defaultEnabled: true, defaultEffort: "low" },
			reasoning: {},
			effort: "low",
		},
		{
			name: "missing support",
			thinking: { mode: "effort", effortLevels: ["high"] },
			reasoning: { effort: "high" },
			effort: undefined,
		},
		{
			name: "unknown default",
			thinking: { supported: true, mode: "effort", effortLevels: ["none", "medium"] },
			reasoning: {},
			effort: undefined,
		},
		{
			name: "invalid effort",
			thinking: { supported: true, mode: "effort", effortLevels: ["low"] },
			reasoning: { effort: "high" },
			effort: undefined,
		},
		{
			name: "required stale disable",
			thinking: { supported: true, mode: "effort", canDisable: false, effortLevels: ["low"] },
			reasoning: { effort: "none" },
			effort: undefined,
		},
		{
			name: "legacy max alias",
			thinking: { supported: true, mode: "effort", effortLevels: ["xhigh"] },
			reasoning: { effort: "max" },
			effort: "xhigh",
		},
	])("encodes OpenAI $name only from legal declarations", async ({ thinking, reasoning, effort }) => {
		const modelId = "openai/o-misleading-alias"
		const profile = ApiProfile.create({
			provider,
			modelId,
			modelInfo: { id: modelId, capabilities: { thinking } },
			requesty: provider === "requesty" ? { reasoning } : undefined,
			litellm: provider === "litellm" ? { reasoning } : undefined,
		})
		const handler =
			provider === "requesty" ? new RequestyHandler({ profile, mode: "act" }) : new LiteLlmHandler({ profile, mode: "act" })
		const create = vi.fn().mockResolvedValue((async function* () {})())
		;(handler as unknown as { client: unknown }).client = { chat: { completions: { create } } }
		if (provider === "litellm") {
			;(handler as unknown as { fetchModelsInfo: () => Promise<unknown> }).fetchModelsInfo = async () => ({ data: [] })
		}
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
		}
		const body = create.mock.calls[0][0]
		expect(body.reasoning_effort).toBe(effort)
		expect(body.thinking).toBeUndefined()
	})
})

it("Requesty rejects stale metadata at the actual request boundary", async () => {
	const id = "openai/private-unknown"
	const handler = new RequestyHandler({
		profile: ApiProfile.create({
			provider: "requesty",
			modelId: id,
			modelInfo: {
				id: "another-model",
				capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["high"] } },
			},
			requesty: { reasoning: { effort: "high" } },
		}),
		mode: "act",
	})
	const create = vi.fn().mockResolvedValue((async function* () {})())
	;(handler as unknown as { client: unknown }).client = { chat: { completions: { create } } }
	for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
	}
	expect(create.mock.calls[0][0].model).toBe(id)
	expect(create.mock.calls[0][0].reasoning_effort).toBeUndefined()
})

describe.each(["vertex", "bedrock"] as const)("%s declared Messages API thinking", (provider) => {
	const cases: {
		name: string
		capabilities: ModelCapabilities
		reasoning: ReasoningConfig
		thinking?: unknown
		effort?: string
	}[] = [
		{ name: "missing mode", capabilities: { supportsReasoning: true }, reasoning: { thinkingBudget: 1600 } },
		{
			name: "explicit unsupported",
			capabilities: { supportsReasoning: true, thinking: { supported: false, mode: "effort" } },
			reasoning: { effort: "high" },
		},
		{
			name: "declared budget despite adaptive-looking name",
			capabilities: { thinking: { supported: true, mode: "budget", maxBudget: 1200 } },
			reasoning: { thinkingBudget: 1600 },
			thinking: { type: "enabled", budget_tokens: 1200 },
		},
		{
			name: "required adaptive despite stale disable",
			capabilities: { thinking: { supported: true, mode: "effort", canDisable: false, effortLevels: ["low", "high"] } },
			reasoning: { effort: "none", enableThinking: false },
			thinking: { type: "adaptive" },
		},
		{
			name: "declared default effort",
			capabilities: {
				thinking: { supported: true, mode: "effort", defaultEnabled: true, defaultEffort: "low", effortLevels: ["low"] },
			},
			reasoning: {},
			thinking: { type: "adaptive" },
			effort: "low",
		},
	]
	it.each(cases)("encodes $name from complete effective metadata", async ({ capabilities, reasoning, thinking, effort }) => {
		const modelId = "claude-opus-5-5-alias"
		const profile = ApiProfile.create({
			provider,
			modelId,
			modelInfo: { id: modelId, name: "Effective alias", capabilities },
			vertex: provider === "vertex" ? { reasoning } : undefined,
			bedrock: provider === "bedrock" ? { reasoning } : undefined,
		})
		type RequestBody = {
			model?: string
			modelId?: string
			thinking?: unknown
			output_config?: unknown
			additionalModelRequestFields?: RequestBody
		}
		let body: RequestBody | undefined
		const stream = () => (async function* () {})()
		if (provider === "vertex") {
			const handler = new VertexHandler({ profile, mode: "act" })
			;(handler as unknown as { ensureGeminiHandler: unknown }).ensureGeminiHandler = () => {
				throw new Error("Unexpected Gemini route: effective Claude alias was replaced")
			}
			;(handler as unknown as { clientAnthropic: unknown }).clientAnthropic = {
				beta: {
					messages: {
						create: vi.fn(async (request) => {
							body = request
							return stream()
						}),
					},
				},
			}
			for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
			}
			expect(body?.model).toBe(modelId)
		} else {
			const handler = new AwsBedrockHandler({ profile, mode: "act" })
			;(handler as unknown as { getBedrockClient: () => Promise<unknown> }).getBedrockClient = async () => ({
				send: async (command: { input: RequestBody }) => {
					body = command.input
					return { stream: stream() }
				},
			})
			for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
			}
			expect(body?.modelId).toBe(modelId)
			body = body?.additionalModelRequestFields
		}
		expect(body?.thinking).toEqual(thinking)
		expect(body?.output_config).toEqual(effort ? { effort } : undefined)
	})
})

describe("MiniMax declared thinking switch", () => {
	const cases: {
		name: string
		capabilities: ModelCapabilities
		reasoning?: ReasoningConfig
		thinking?: unknown
		enabled?: boolean
		effort?: string
	}[] = [
		{ name: "coarse support is not a mode", capabilities: { supportsReasoning: true }, reasoning: { thinkingBudget: 1600 } },
		{
			name: "nested false vetoes budget",
			capabilities: { supportsReasoning: true, thinking: { supported: false, mode: "effort" } },
			reasoning: { thinkingBudget: 1600 },
		},
		{
			name: "coarse false vetoes nested support",
			capabilities: { supportsReasoning: false, thinking: { supported: true, mode: "effort", defaultEnabled: true } },
		},
		{ name: "unknown default", capabilities: { thinking: { supported: true, mode: "effort" } } },
		{
			name: "budget mode has no MiniMax wire",
			capabilities: { thinking: { supported: true, mode: "budget" } },
			reasoning: { thinkingBudget: 1600 },
		},
		{
			name: "declared default ignores legacy budget",
			capabilities: { thinking: { supported: true, mode: "effort", defaultEnabled: true } },
			reasoning: { thinkingBudget: -1 },
			thinking: { type: "adaptive" },
			enabled: true,
		},
		{
			name: "explicit enable sends no ignored budget",
			capabilities: { thinking: { supported: true, mode: "effort" } },
			reasoning: { enableThinking: true, thinkingBudget: 1600 },
			thinking: { type: "adaptive" },
			enabled: true,
		},
		{
			name: "explicit disable",
			capabilities: { thinking: { supported: true, mode: "effort", defaultEnabled: true } },
			reasoning: { enableThinking: false },
			thinking: { type: "disabled" },
		},
		{
			name: "none overrides enable",
			capabilities: { thinking: { supported: true, mode: "effort", defaultEnabled: true } },
			reasoning: { enableThinking: true, effort: "none" },
			thinking: { type: "disabled" },
		},
		{
			name: "required ignores stale disable",
			capabilities: { thinking: { supported: true, mode: "effort", canDisable: false } },
			reasoning: { enableThinking: false, effort: "none" },
			thinking: { type: "adaptive" },
			enabled: true,
		},
	]
	it.each([
		...cases,
		{
			name: "legal effort",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["high"] } },
			reasoning: { effort: "high" },
			thinking: { type: "adaptive" },
			enabled: true,
			effort: "high",
		},
		{
			name: "declared effort default",
			capabilities: {
				thinking: { supported: true, mode: "effort", effortLevels: ["low"], defaultEnabled: true, defaultEffort: "low" },
			},
			thinking: { type: "adaptive" },
			enabled: true,
			effort: "low",
		},
		{
			name: "invalid effort has no wire",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["low"], defaultEnabled: true } },
			reasoning: { effort: "high" },
			thinking: { type: "adaptive" },
			enabled: true,
		},
		{
			name: "empty list has no effort default",
			capabilities: {
				thinking: { supported: true, mode: "effort", effortLevels: [], defaultEnabled: true, defaultEffort: "max" },
			},
			thinking: { type: "adaptive" },
			enabled: true,
		},
		{
			name: "legacy ultra alias",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["max"] } },
			reasoning: { effort: "ultra" },
			thinking: { type: "adaptive" },
			enabled: true,
			effort: "max",
		},
	])("encodes $name from effective metadata", async ({ capabilities, reasoning, thinking, enabled, effort }) => {
		const modelId = "claude-misleading-minimax-alias"
		const handler = new MinimaxHandler({
			profile: ApiProfile.create({
				provider: "minimax",
				modelId,
				modelInfo: { id: modelId, capabilities },
				minimax: { reasoning },
			}),
			mode: "act",
		})
		const create = vi.fn().mockResolvedValue((async function* () {})())
		;(handler as unknown as { client: unknown }).client = { messages: { create } }
		for await (const _chunk of handler.createMessage(
			"system",
			[{ role: "user", content: "hi" }],
			[{ name: "read_file", description: "Read", input_schema: { type: "object", properties: {} } }],
		)) {
		}
		const body = create.mock.calls[0][0]
		expect(body.model).toBe(modelId)
		expect(body.thinking).toEqual(thinking)
		expect(body.output_config).toEqual(effort ? { effort } : undefined)
		expect(body.temperature).toBe(enabled ? undefined : 1)
		expect(body.tool_choice).toEqual(enabled ? undefined : { type: "any" })
	})
	it("keeps bundled M2 thinking mandatory despite a stale Profile disable", async () => {
		const handler = new MinimaxHandler({
			profile: ApiProfile.create({
				provider: "minimax",
				modelId: "MiniMax-M2.7",
				minimax: { reasoning: { enableThinking: false, effort: "none", thinkingBudget: 0 } },
			}),
			mode: "act",
		})
		const create = vi.fn().mockResolvedValue((async function* () {})())
		;(handler as unknown as { client: unknown }).client = { messages: { create } }
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
		}
		expect(create.mock.calls[0][0].model).toBe("MiniMax-M2.7")
		expect(create.mock.calls[0][0].thinking).toEqual({ type: "adaptive" })
	})
	it.each([
		undefined,
		{ id: "MiniMax-M2.7", capabilities: { supportsReasoning: true } },
	])("keeps an explicit unknown model identity without a default envelope", async (modelInfo) => {
		const modelId = "private-minimax-alias"
		const handler = new MinimaxHandler({
			profile: ApiProfile.create({ provider: "minimax", modelId, modelInfo }),
			mode: "act",
		})
		expect(handler.getModel()).toEqual({ id: modelId, info: { id: modelId } })
		const create = vi.fn().mockResolvedValue((async function* () {})())
		;(handler as unknown as { client: unknown }).client = { messages: { create } }
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
		}
		expect(create.mock.calls[0][0].model).toBe(modelId)
		expect(create.mock.calls[0][0].thinking).toBeUndefined()
	})
})

/** Exercise effective declarations at the actual native request boundary, without substituting getModel. */
describe.each(["mistral", "minimax"] as const)("%s effective native tool choice", (provider) => {
	it.each([undefined, true, false])("uses the declared forced-tool flag %s without model-name inference", async (declared) => {
		const modelId = "claude-opus-5-5-alias"
		const profile = ApiProfile.create({
			provider,
			modelId,
			modelInfo: {
				id: modelId,
				name: "Effective alias",
				capabilities: { supportsTools: true, supportsForcedToolUse: declared, thinking: { supported: false } },
			},
		})
		const handler =
			provider === "mistral" ? new MistralHandler({ profile, mode: "act" }) : new MinimaxHandler({ profile, mode: "act" })
		const create = vi.fn().mockResolvedValue((async function* () {})())
		;(handler as unknown as { client: unknown }).client =
			provider === "mistral" ? { chat: { stream: create } } : { messages: { create } }
		const tools =
			provider === "mistral"
				? [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }]
				: [{ name: "read_file", description: "Read", input_schema: { type: "object", properties: {} } }]
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "read" }], tools as never)) {
		}
		const body = create.mock.calls[0]?.[0]
		expect(body.model).toBe(modelId)
		expect(handler.getModel().info.name).toBe("Effective alias")
		if (provider === "mistral") {
			expect(body.toolChoice).toBe(declared === false ? "auto" : "any")
		} else {
			expect(body.tool_choice).toEqual({ type: declared === false ? "auto" : "any" })
		}
	})
})
