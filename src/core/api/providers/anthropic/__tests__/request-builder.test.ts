import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import type { ModelInfo } from "@shared/api"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import type { AnthropicReasoning } from "../reasoning"
import { type AnthropicMessagesRequestInput, buildAnthropicMessagesRequest } from "../request-builder"

const readFile: AnthropicTool = { name: "read_file", description: "Read", input_schema: { type: "object", properties: {} } }
const noThinking: AnthropicReasoning = { enabled: false, adaptive: false }

function input(
	overrides: Partial<AnthropicMessagesRequestInput> & { promptCache?: boolean } = {},
): AnthropicMessagesRequestInput {
	const { promptCache = true, ...rest } = overrides
	return {
		model: "claude-test",
		modelInfo: { id: "claude-test", capabilities: { supportsPromptCache: promptCache, maxTokens: 4_096 } } as ModelInfo,
		systemPrompt: "system prompt",
		messages: [{ role: "user", content: "hello" }],
		reasoning: noThinking,
		forcedToolChoice: "model_declared",
		...rest,
	}
}

describe("buildAnthropicMessagesRequest", () => {
	it("keeps the cache breakpoint on the system prompt behind an uncached prefix", () => {
		const body = buildAnthropicMessagesRequest(input({ systemPrefix: [{ type: "text", text: "attribution" }] }))

		expect(body.system).toEqual([
			{ type: "text", text: "attribution" },
			{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } },
		])
		expect(body).toMatchObject({ model: "claude-test", max_tokens: 4_096, temperature: 0, stream: true })
	})

	it("omits the cache breakpoint for a model without prompt caching", () => {
		const body = buildAnthropicMessagesRequest(input({ promptCache: false }))

		expect(body.system).toEqual([{ type: "text", text: "system prompt" }])
	})

	it.each([
		{ forcedToolChoice: "model_declared", promptCache: true },
		{ forcedToolChoice: "never", promptCache: false },
	] as const)("sends no tool_choice when the request declares no local tools ($forcedToolChoice)", (scenario) => {
		const body = buildAnthropicMessagesRequest(input(scenario))

		expect(body).not.toHaveProperty("tool_choice")
		expect(body).not.toHaveProperty("tools")
	})

	it("forces a local tool only when the model allows it and nothing else forbids it", () => {
		expect(buildAnthropicMessagesRequest(input({ tools: [readFile] })).tool_choice).toEqual({ type: "any" })
		expect(buildAnthropicMessagesRequest(input({ tools: [readFile], forcedToolChoice: "never" })).tool_choice).toEqual({
			type: "auto",
		})
		const rejectsForcing = { id: "claude-test", capabilities: { supportsForcedToolUse: false } } as ModelInfo
		expect(buildAnthropicMessagesRequest(input({ tools: [readFile], modelInfo: rejectsForcing })).tool_choice).toEqual({
			type: "auto",
		})
	})

	it("leaves the choice automatic when a hosted tool is merged beside local tools", () => {
		const body = buildAnthropicMessagesRequest(input({ tools: [readFile], options: { serverTools: [ServerTool.WEB_FETCH] } }))

		expect(body.tool_choice).toEqual({ type: "auto" })
		expect((body.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["read_file", "web_fetch"])
	})

	it("declares hosted tools without a tool_choice when no local tool is present", () => {
		const body = buildAnthropicMessagesRequest(input({ options: { serverTools: [ServerTool.WEB_SEARCH] } }))

		expect((body.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(["web_search"])
		expect(body).not.toHaveProperty("tool_choice")
	})

	it("drops temperature and forced choice while thinking, and carries thinking and output config", () => {
		const reasoning: AnthropicReasoning = {
			enabled: true,
			adaptive: true,
			thinking: { type: "adaptive" },
			outputConfig: { effort: "high" },
		}
		const body = buildAnthropicMessagesRequest(input({ tools: [readFile], reasoning }))

		expect(body.temperature).toBeUndefined()
		expect(body).not.toHaveProperty("tool_choice")
		expect(body.thinking).toEqual({ type: "adaptive" })
		expect(body.output_config).toEqual({ effort: "high" })
	})

	it("uses the compaction output budget instead of the model maximum", () => {
		const body = buildAnthropicMessagesRequest(
			input({ options: { generation: { purpose: "compaction", maxOutputTokens: 30_000 } } }),
		)

		expect(body.max_tokens).toBe(30_000)
	})
})
