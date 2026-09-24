import type { Anthropic } from "@anthropic-ai/sdk"
import { AnthropicHandler } from "@core/api/providers/anthropic"
import { OpenAiHandler } from "@core/api/providers/openai"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ClineStorageMessage } from "@/shared/messages/content"
import { MODEL_SWITCH_NOTICE, projectCrossModelHistory } from "@/shared/messages/cross-model-history"
import { type ApiHandlerContext, buildApiHandlerFromProfile } from "../../index"
import { sanitizeAnthropicMessages } from "../anthropic-format"
import { convertDeepSeekMessages } from "../deepseek-format"
import { convertToOpenAiMessages, sanitizeGeminiMessages } from "../openai-format"
import { convertToOpenAIResponsesInput } from "../openai-response-format"
import type { ApiStream } from "../stream"

const TARGET_MODEL = "gpt-5.6-sol"
const FOREIGN_MODEL = "claude-opus-5-5"
const FOREIGN_PROVIDER = "stored-foreign-provider"

const profile = ApiProfile.create({
	name: "cross-model-history-test",
	provider: "openai",
	apiKey: "test-api-key",
	modelId: TARGET_MODEL,
	openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
})

/** History produced by another model: signed reasoning, ciphertext, and a recent response id. */
function foreignHistory(): ClineStorageMessage[] {
	return [
		{ role: "user", content: "Read a.ts" },
		{
			role: "assistant",
			modelInfo: { modelId: FOREIGN_MODEL, providerId: FOREIGN_PROVIDER, mode: "act" },
			provider_metadata: { response_id: "resp_foreign" },
			ts: Date.now(),
			content: [
				{ type: "thinking", thinking: "Inspect a.ts first.", signature: "claude-signature" },
				{ type: "redacted_thinking", data: "claude-ciphertext" },
				{ type: "tool_use", function_id: "call_1", dline_tid: "dline_tid_1", name: "read_file", input: { path: "a.ts" } },
			],
		},
		{
			role: "user",
			content: [{ type: "tool_result", function_id: "call_1", dline_tid: "dline_tid_1", content: "export {}" }],
		},
	]
}

function emptyStream(): ApiStream {
	return (async function* () {})()
}

function buildHandler() {
	return buildApiHandlerFromProfile({ actModeProfile: profile.name }, "act", profile)
}

describe("withCrossModelHistory at handler construction", () => {
	afterEach(() => vi.restoreAllMocks())

	it("sends projected history and keeps the handler's identity", async () => {
		const sent: ClineStorageMessage[][] = []
		vi.spyOn(OpenAiHandler.prototype, "createMessage").mockImplementation((_system, messages) => {
			sent.push(messages)
			return emptyStream()
		})
		const handler = buildHandler()

		for await (const _chunk of handler.createMessage("system", foreignHistory())) {
			// drain
		}

		expect(sent).toHaveLength(1)
		const [, projectedAssistant, projectedUser] = sent[0]
		expect(projectedAssistant.content).toStrictEqual([
			{ type: "text", text: "<prior_model_reasoning>\nInspect a.ts first.\n</prior_model_reasoning>" },
			{ type: "tool_use", function_id: "call_1", dline_tid: "dline_tid_1", name: "read_file", input: { path: "a.ts" } },
		])
		expect(projectedAssistant).not.toHaveProperty("provider_metadata")
		expect(projectedUser.content).toContainEqual({ type: "text", text: MODEL_SWITCH_NOTICE })
		expect(handler).toBeInstanceOf(OpenAiHandler)
		expect((handler as unknown as { ctx: ApiHandlerContext }).ctx.profile.name).toBe(profile.name)
		expect(handler.getProviderId?.()).toBe("openai")
	})

	it("serializes no foreign ciphertext, response id, or stored model identity on the wire", async () => {
		let projected: ClineStorageMessage[] = []
		vi.spyOn(OpenAiHandler.prototype, "createMessage").mockImplementation((_system, messages) => {
			projected = messages
			return emptyStream()
		})
		for await (const _chunk of buildHandler().createMessage("system", foreignHistory())) {
			// drain
		}

		const responses = convertToOpenAIResponsesInput(projected, { usePreviousResponseId: true })
		const anthropic = sanitizeAnthropicMessages(projected, true)
		const wire = JSON.stringify({ responses, anthropic })

		expect(responses.previousResponseId).toBeUndefined()
		expect(wire).not.toContain("claude-ciphertext")
		expect(wire).not.toContain("claude-signature")
		expect(wire).not.toContain("resp_foreign")
		expect(wire).not.toContain(FOREIGN_MODEL)
		expect(wire).not.toContain(FOREIGN_PROVIDER)
		expect(wire).not.toContain(TARGET_MODEL)
		expect(wire).toContain("<prior_model_reasoning>")
	})

	it("never re-sends foreign reasoning as the target's own reasoning on Chat or DeepSeek wires", async () => {
		let projected: ClineStorageMessage[] = []
		vi.spyOn(OpenAiHandler.prototype, "createMessage").mockImplementation((_system, messages) => {
			projected = messages
			return emptyStream()
		})
		for await (const _chunk of buildHandler().createMessage("system", foreignHistory())) {
			// drain
		}

		const chat = convertToOpenAiMessages(projected)
		const deepseek = convertDeepSeekMessages(projected, "system")
		const deepseekAssistant = deepseek.find((message) => message.role === "assistant") as
			| { content?: unknown; reasoning_content?: string; tool_calls?: unknown[] }
			| undefined
		const wire = JSON.stringify({ chat, deepseek })

		expect(deepseekAssistant?.reasoning_content).toBe("")
		expect(deepseekAssistant?.content).toContain("<prior_model_reasoning>")
		expect(deepseekAssistant?.tool_calls).toHaveLength(1)
		expect(wire).not.toContain("claude-ciphertext")
		expect(wire).not.toContain("claude-signature")
		expect(wire).not.toContain(FOREIGN_MODEL)
		expect(wire).not.toContain(FOREIGN_PROVIDER)
		expect(wire).not.toContain(TARGET_MODEL)
		expect(JSON.stringify(chat)).toContain("<prior_model_reasoning>")

		// The notice is plain user text that follows the tool results, never a tool message.
		const chatToolIndex = chat.findIndex((message) => message.role === "tool")
		expect(chat[chatToolIndex + 1]).toStrictEqual({ role: "user", content: [{ type: "text", text: MODEL_SWITCH_NOTICE }] })
		const deepseekToolIndex = deepseek.findIndex((message) => message.role === "tool")
		expect(deepseek[deepseekToolIndex + 1]).toStrictEqual({ role: "user", content: MODEL_SWITCH_NOTICE })
	})

	it("keeps same-model history untouched through the handler", async () => {
		const sent: ClineStorageMessage[][] = []
		vi.spyOn(OpenAiHandler.prototype, "createMessage").mockImplementation((_system, messages) => {
			sent.push(messages)
			return emptyStream()
		})
		const history = foreignHistory().map((message): ClineStorageMessage => {
			if (!message.modelInfo) return message
			return { ...message, modelInfo: { ...message.modelInfo, modelId: TARGET_MODEL, providerId: "other" } }
		})

		for await (const _chunk of buildHandler().createMessage("system", history)) {
			// drain
		}

		for (const [index, message] of sent[0].entries()) {
			expect(message).toBe(history[index])
		}
	})
})

describe("cross-model history on provider wires", () => {
	afterEach(() => vi.restoreAllMocks())

	it("keeps Gemini tool calls that carry their own reasoning_details after a Gemini model switch", () => {
		const target = "google/gemini-3-pro"
		const history: ClineStorageMessage[] = [
			{ role: "user", content: "List files" },
			{
				role: "assistant",
				modelInfo: { modelId: "google/gemini-3-flash", providerId: FOREIGN_PROVIDER, mode: "act" },
				content: [
					{ type: "thinking", thinking: "List first.", signature: "" },
					{
						type: "tool_use",
						function_id: "call_g",
						dline_tid: "dline_tid_g",
						name: "list_files",
						input: {},
						reasoning_details: [{ type: "reasoning.encrypted", data: "gemini-thought", id: "call_g" }],
					},
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", function_id: "call_g", dline_tid: "dline_tid_g", content: "a.ts" }],
			},
		]
		const toOpenRouterGemini = (messages: ClineStorageMessage[]) =>
			sanitizeGeminiMessages(convertToOpenAiMessages(messages), target)
		const assistantOf = (messages: ReturnType<typeof toOpenRouterGemini>) =>
			messages.find((message) => message.role === "assistant") as { tool_calls?: unknown[]; reasoning_details?: unknown }

		const before = toOpenRouterGemini(history)
		const after = toOpenRouterGemini(projectCrossModelHistory(history, target))

		expect(assistantOf(after).tool_calls).toHaveLength(1)
		expect(assistantOf(after).tool_calls).toStrictEqual(assistantOf(before).tool_calls)
		expect(assistantOf(after).reasoning_details).toStrictEqual(assistantOf(before).reasoning_details)
		expect(after.some((message) => message.role === "tool")).toBe(true)
	})

	it("never chains a foreign string-content turn through previous_response_id", () => {
		const history: ClineStorageMessage[] = [
			{ role: "user", content: "Hi" },
			{
				role: "assistant",
				content: "Hello from before.",
				modelInfo: { modelId: FOREIGN_MODEL, providerId: FOREIGN_PROVIDER, mode: "act" },
				provider_metadata: { response_id: "resp_string" },
				ts: Date.now(),
			},
			{ role: "user", content: "Continue" },
		]

		const unprojected = convertToOpenAIResponsesInput(history, { usePreviousResponseId: true })
		const projected = convertToOpenAIResponsesInput(projectCrossModelHistory(history, TARGET_MODEL), {
			usePreviousResponseId: true,
		})

		expect(unprojected.previousResponseId).toBe("resp_string")
		expect(projected.previousResponseId).toBeUndefined()
		expect(JSON.stringify(projected.input)).toContain("Hello from before.")
	})

	it("sends a thinking-enabled Anthropic request without foreign reasoning blocks and with paired tool results", async () => {
		const anthropicProfile = ApiProfile.create({
			name: "cross-model-history-anthropic-test",
			provider: "anthropic",
			apiKey: "test-api-key",
			modelId: "claude-opus-4-7",
			anthropic: { reasoning: { effort: "xhigh" } },
		})
		const handler = buildApiHandlerFromProfile({ actModeProfile: anthropicProfile.name }, "act", anthropicProfile)
		const create = vi.fn().mockResolvedValue(emptyStream())
		vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
			messages: { create },
			beta: { messages: { _client: {}, create: vi.fn().mockResolvedValue(emptyStream()) } },
		})
		const responsesHistory: ClineStorageMessage[] = [
			{ role: "user", content: "Read a.ts" },
			{
				role: "assistant",
				modelInfo: { modelId: TARGET_MODEL, providerId: FOREIGN_PROVIDER, mode: "act" },
				provider_metadata: { response_id: "resp_openai" },
				ts: Date.now(),
				content: [
					{ type: "redacted_thinking", data: "openai-ciphertext", provider_metadata: { response_id: "rs_1" } },
					{
						type: "thinking",
						thinking: "",
						signature: "",
						summary: [{ type: "summary_text", text: "Read a.ts first." }],
						provider_metadata: { response_id: "rs_1" },
					},
					{
						type: "tool_use",
						function_id: "call_1",
						dline_tid: "dline_tid_1",
						name: "read_file",
						input: { path: "a.ts" },
						provider_metadata: { item_id: "fc_1" },
					},
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", function_id: "call_1", dline_tid: "dline_tid_1", content: "export {}" }],
			},
		]

		for await (const _chunk of handler.createMessage("system", responsesHistory)) {
			// drain
		}

		expect(handler).toBeInstanceOf(AnthropicHandler)
		const body = create.mock.calls[0][0] as { thinking?: unknown; messages: Anthropic.MessageParam[] }
		expect(body.thinking).toStrictEqual({ type: "adaptive" })
		const [, assistantTurn, resultTurn] = body.messages
		expect(assistantTurn.content).toStrictEqual([
			{ type: "text", text: "<prior_model_reasoning>\nRead a.ts first.\n</prior_model_reasoning>" },
			{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
		])
		const resultBlocks = resultTurn.content as Anthropic.ContentBlockParam[]
		expect(resultBlocks[0]).toMatchObject({ type: "tool_result", tool_use_id: "call_1" })
		expect(resultBlocks.at(-1)).toMatchObject({ type: "text", text: MODEL_SWITCH_NOTICE })
		const blockTypes = body.messages.flatMap((message) =>
			Array.isArray(message.content) ? message.content.map((block) => block.type) : [],
		)
		expect(blockTypes).not.toContain("thinking")
		expect(blockTypes).not.toContain("redacted_thinking")
		const messagesWire = JSON.stringify(body.messages)
		expect(messagesWire).not.toContain("openai-ciphertext")
		expect(messagesWire).not.toContain(TARGET_MODEL)
		expect(messagesWire).not.toContain(FOREIGN_PROVIDER)
	})
})
