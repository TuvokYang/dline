import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { describe, expect, it, vi } from "vitest"
import { AwsBedrockHandler } from "../bedrock"
import { LiteLlmHandler } from "../litellm"
import { MinimaxHandler } from "../minimax"
import { MistralHandler } from "../mistral"
import { RequestyHandler } from "../requesty"
import { VertexHandler } from "../vertex"

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
