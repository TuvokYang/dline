import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { describe, expect, it, vi } from "vitest"
import { AwsBedrockHandler } from "../bedrock"
import { MinimaxHandler } from "../minimax"
import { MistralHandler } from "../mistral"
import { VertexHandler } from "../vertex"

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
