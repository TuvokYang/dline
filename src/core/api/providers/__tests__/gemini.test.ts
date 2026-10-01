import "should"
import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import { afterEach, describe, expect, it, vi } from "vitest"
import { GeminiHandler } from "../gemini"

describe("GeminiHandler", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	const createAsyncIterable = (data: any[] = []) => ({
		[Symbol.asyncIterator]: async function* () {
			yield* data
		},
	})

	it("caps maxOutputTokens to 8192 for Flash models", async () => {
		const handler = new GeminiHandler({
			profile: ApiProfile.create({ provider: "gemini", apiKey: "test-api-key", modelId: "gemini-2.5-flash" }),
			mode: "act",
		})

		const generateContentStream = vi.fn().mockResolvedValue(
			createAsyncIterable([
				{
					responseId: "resp-1",
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 20,
						cachedContentTokenCount: 0,
						thoughtsTokenCount: 0,
					},
				},
			]),
		)
		vi.spyOn(handler as any, "ensureClient").mockReturnValue({
			models: { generateContentStream },
		} as any)

		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
			// Consume stream to trigger request execution.
		}

		const requestArgs = generateContentStream.mock.calls[0][0] as Record<string, any>
		requestArgs.config.should.have.property("maxOutputTokens", 8_192)
	})

	/**
	 * Drive one request and return the config the SDK was called with.
	 *
	 * `resolvedModel` can isolate wire-only checks. Profile-carried metadata
	 * exercises the normal effective-model resolution boundary without replacing it.
	 */
	const captureRequestConfig = async (
		profile: ApiProfile,
		tools?: unknown[],
		resolvedModel?: { id: string; info: Record<string, any> },
	) => {
		const handler = new GeminiHandler({ profile, mode: "act" })
		const generateContentStream = vi.fn().mockResolvedValue(createAsyncIterable([{ responseId: "resp-1" }]))
		vi.spyOn(handler as any, "ensureClient").mockReturnValue({ models: { generateContentStream } } as any)
		if (resolvedModel) {
			vi.spyOn(handler, "getModel").mockReturnValue(resolvedModel as any)
		}

		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any, tools as any)) {
			// Consume stream to trigger request execution.
		}

		return (generateContentStream.mock.calls[0][0] as Record<string, any>).config
	}

	const reasoningCases: {
		name: string
		capabilities: ModelCapabilities
		reasoning?: ReasoningConfig
		thinkingConfig?: Record<string, unknown>
	}[] = [
		{
			name: "missing declaration",
			capabilities: { supportsReasoning: true },
			reasoning: { effort: "high", thinkingBudget: 1000 },
		},
		{
			name: "unsupported nested declaration",
			capabilities: { thinking: { supported: false, mode: "effort", effortLevels: ["high"] } },
			reasoning: { effort: "high" },
		},
		{
			name: "coarse veto",
			capabilities: { supportsReasoning: false, thinking: { supported: true, mode: "budget" } },
			reasoning: { thinkingBudget: 1000 },
		},
		{
			name: "missing mode",
			capabilities: { thinking: { supported: true, effortLevels: ["high"] } },
			reasoning: { effort: "high" },
		},
		{ name: "unknown defaults", capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["high"] } } },
		{
			name: "empty legal list",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: [], defaultEnabled: true } },
			reasoning: { effort: "high" },
			thinkingConfig: { includeThoughts: true },
		},
		{
			name: "declared default",
			capabilities: {
				thinking: {
					supported: true,
					mode: "effort",
					effortLevels: ["medium"],
					defaultEnabled: true,
					defaultEffort: "medium",
				},
			},
			thinkingConfig: { thinkingLevel: "MEDIUM", includeThoughts: true },
		},
		{
			name: "legal minimal",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["minimal"] } },
			reasoning: { effort: "minimal" },
			thinkingConfig: { thinkingLevel: "MINIMAL", includeThoughts: true },
		},
		{
			name: "legacy xhigh alias",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["high"] } },
			reasoning: { effort: "xhigh" },
			thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true },
		},
		{
			name: "invalid effort inherits provider level",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["low"], defaultEnabled: true } },
			reasoning: { effort: "medium" },
			thinkingConfig: { includeThoughts: true },
		},
		{
			name: "explicit disable wins over enable",
			capabilities: {
				thinking: { supported: true, mode: "effort", canDisable: true, defaultEnabled: true, effortLevels: ["low"] },
			},
			reasoning: { effort: "none", enableThinking: true },
			thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
		},
		{
			name: "required thinking rejects stale disable",
			capabilities: { thinking: { supported: true, mode: "effort", canDisable: false, effortLevels: ["low"] } },
			reasoning: { effort: "none", enableThinking: false },
			thinkingConfig: { includeThoughts: true },
		},
		{
			name: "budget mode ignores effort",
			capabilities: { thinking: { supported: true, mode: "budget", effortLevels: ["high"], maxBudget: 1200 } },
			reasoning: { thinkingBudget: 1600, effort: "high" },
			thinkingConfig: { thinkingBudget: 1200, includeThoughts: true },
		},
		{
			name: "declared positive minimum",
			capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17, maxBudget: 101 } },
			reasoning: { thinkingBudget: 3 },
			thinkingConfig: { thinkingBudget: 17, includeThoughts: true },
		},
		{
			name: "invalid minimum range",
			capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17, maxBudget: 11 } },
			reasoning: { thinkingBudget: 30 },
		},
		{
			name: "dynamic value remains independent of positive minimum",
			capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17 } },
			reasoning: { thinkingBudget: -1 },
			thinkingConfig: { thinkingBudget: -1, includeThoughts: true },
		},
		{
			name: "zero disable remains independent of positive minimum",
			capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17, canDisable: true } },
			reasoning: { thinkingBudget: 0 },
			thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
		},
		{
			name: "no invented budget ceiling",
			capabilities: { thinking: { supported: true, mode: "budget" } },
			reasoning: { thinkingBudget: 28000 },
			thinkingConfig: { thinkingBudget: 28000, includeThoughts: true },
		},
		{
			name: "dynamic declared budget default",
			capabilities: { thinking: { supported: true, mode: "budget", defaultEnabled: true } },
			thinkingConfig: { includeThoughts: true },
		},
		{
			name: "budget zero disables",
			capabilities: { thinking: { supported: true, mode: "budget", canDisable: true } },
			reasoning: { thinkingBudget: 0 },
			thinkingConfig: { thinkingBudget: 0, includeThoughts: false },
		},
		{
			name: "required budget zero inherits",
			capabilities: { thinking: { supported: true, mode: "budget", canDisable: false } },
			reasoning: { thinkingBudget: 0 },
			thinkingConfig: { includeThoughts: true },
		},
		{
			name: "explicit dynamic budget",
			capabilities: { thinking: { supported: true, mode: "budget" } },
			reasoning: { thinkingBudget: -1 },
			thinkingConfig: { thinkingBudget: -1, includeThoughts: true },
		},
		{
			name: "budget preference does not grant an effort default",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["high"] } },
			reasoning: { thinkingBudget: 1600 },
		},
		{
			name: "invalid effort does not grant activation",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["low"] } },
			reasoning: { effort: "high" },
		},
		{
			name: "negative budget",
			capabilities: { thinking: { supported: true, mode: "budget", defaultEnabled: true } },
			reasoning: { thinkingBudget: -2 },
		},
		{
			name: "fractional budget",
			capabilities: { thinking: { supported: true, mode: "budget", defaultEnabled: true } },
			reasoning: { thinkingBudget: 2.5 },
		},
		{
			name: "invalid declared ceiling",
			capabilities: { thinking: { supported: true, mode: "budget", maxBudget: -10 } },
			reasoning: { thinkingBudget: 1000 },
		},
	]
	it.each(reasoningCases)("encodes $name only from effective metadata", async ({ capabilities, reasoning, thinkingConfig }) => {
		const modelId = "gemini-3-pro-misleading-alias"
		const config = await captureRequestConfig(
			ApiProfile.create({
				provider: "gemini",
				modelId,
				modelInfo: { id: modelId, capabilities },
				gemini: { reasoning },
			}),
		)
		expect(config.thinkingConfig).toEqual(thinkingConfig)
	})

	it("caps a bundled Gemini Pro request at its declared budget ceiling", async () => {
		const config = await captureRequestConfig(
			ApiProfile.create({
				provider: "gemini",
				modelId: "gemini-2.5-pro",
				gemini: { reasoning: { thinkingBudget: 40000 } },
			}),
		)
		expect(config.thinkingConfig).toEqual({ thinkingBudget: 32768, includeThoughts: true })
	})

	it("uses the Vertex-owned configuration with declared Gemini metadata", async () => {
		const modelId = "gemini-effective-alias"
		const config = await captureRequestConfig(
			ApiProfile.create({
				provider: "vertex",
				modelId,
				modelInfo: {
					id: modelId,
					capabilities: { thinking: { supported: true, mode: "effort", effortLevels: ["medium"] } },
				},
				vertex: { reasoning: { effort: "medium" } },
				gemini: { reasoning: { effort: "high" } },
			}),
		)
		expect(config.thinkingConfig).toEqual({ thinkingLevel: "MEDIUM", includeThoughts: true })
	})

	it.each([
		undefined,
		{ id: "gemini-2.5-pro", capabilities: { thinking: { supported: true, mode: "budget" } } },
	])("preserves an explicit unknown model ID without borrowing stale or default metadata", async (modelInfo) => {
		const modelId = "private-gemini-alias"
		const profile = ApiProfile.create({
			provider: "gemini",
			modelId,
			modelInfo,
			gemini: { reasoning: { thinkingBudget: 1000 } },
		})
		const handler = new GeminiHandler({ profile, mode: "act" })
		expect(handler.getModel()).toEqual({ id: modelId, info: { id: modelId } })
		const generateContentStream = vi.fn().mockResolvedValue(createAsyncIterable())
		;(handler as unknown as { ensureClient: () => unknown }).ensureClient = () => ({ models: { generateContentStream } })
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
		}
		expect(generateContentStream.mock.calls[0][0].model).toBe(modelId)
		expect(generateContentStream.mock.calls[0][0].config.thinkingConfig).toBeUndefined()
	})

	const TOOL_DECLARATIONS = [{ name: "read_file", description: "read", parameters: { type: "object", properties: {} } }]
	const GEMINI_PROFILE = ApiProfile.create({ provider: "gemini", apiKey: "test-api-key", modelId: "gemini-2.5-pro" })

	it("forces a tool call by default, which is what Gemini accepts", async () => {
		const config = await captureRequestConfig(GEMINI_PROFILE, TOOL_DECLARATIONS)

		config.toolConfig.functionCallingConfig.should.have.property("mode", "ANY")
	})

	it("honours a model that declares it rejects a forced tool call", async () => {
		const config = await captureRequestConfig(
			ApiProfile.create({
				...GEMINI_PROFILE,
				modelInfo: { id: GEMINI_PROFILE.modelId, capabilities: { supportsTools: true, supportsForcedToolUse: false } },
			}),
			TOOL_DECLARATIONS,
		)

		config.toolConfig.functionCallingConfig.should.have.property("mode", "AUTO")
	})

	it("does not set maxOutputTokens for non-Flash models", async () => {
		const handler = new GeminiHandler({
			profile: ApiProfile.create({ provider: "gemini", apiKey: "test-api-key", modelId: "gemini-2.5-pro" }),
			mode: "act",
		})

		const generateContentStream = vi.fn().mockResolvedValue(
			createAsyncIterable([
				{
					responseId: "resp-2",
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 20,
						cachedContentTokenCount: 0,
						thoughtsTokenCount: 0,
					},
				},
			]),
		)
		vi.spyOn(handler as any, "ensureClient").mockReturnValue({
			models: { generateContentStream },
		} as any)

		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }] as any)) {
			// Consume stream to trigger request execution.
		}

		const requestArgs = generateContentStream.mock.calls[0][0] as Record<string, any>
		requestArgs.config.should.not.have.property("maxOutputTokens")
	})

	it("should emit unique tool call IDs when multiple function calls share one responseId", async () => {
		const handler = new GeminiHandler({
			profile: ApiProfile.create({ provider: "gemini", apiKey: "test-api-key" }),
			mode: "act",
		})

		const fakeClient = {
			models: {
				generateContentStream: vi.fn().mockResolvedValue(
					createAsyncIterable([
						{
							responseId: "resp_1",
							candidates: [
								{
									content: {
										parts: [
											{
												functionCall: {
													name: "read_file",
													args: { path: ".nvmrc" },
												},
											},
										],
									},
								},
							],
						},
						{
							responseId: "resp_1",
							candidates: [
								{
									content: {
										parts: [
											{
												functionCall: {
													name: "read_file",
													args: { path: ".gitattributes" },
												},
											},
										],
									},
								},
							],
						},
					]),
				),
			},
		}
		vi.spyOn(handler as any, "ensureClient").mockReturnValue(fakeClient as any)

		const tools = [{ name: "read_file", description: "read file", parameters: { type: "OBJECT" } }] as any
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], tools)) {
			if (chunk.type === "tool_calls") {
				chunks.push(chunk)
			}
		}

		chunks.should.have.length(2)
		chunks[0].function_id.should.equal("resp_1-tool-0")
		chunks[1].function_id.should.equal("resp_1-tool-1")
		chunks[0].provider_metadata.response_id.should.equal("resp_1")
		chunks[0].tool_call.should.not.have.property("call_id")
		chunks[0].tool_call.function.should.not.have.property("id")
		JSON.parse(chunks[0].tool_call.function.arguments).path.should.equal(".nvmrc")
		JSON.parse(chunks[1].tool_call.function.arguments).path.should.equal(".gitattributes")
	})

	it("should preserve Gemini-provided functionCall.id when present", async () => {
		const handler = new GeminiHandler({
			profile: ApiProfile.create({ provider: "gemini", apiKey: "test-api-key" }),
			mode: "act",
		})

		const fakeClient = {
			models: {
				generateContentStream: vi.fn().mockResolvedValue(
					createAsyncIterable([
						{
							responseId: "resp_2",
							candidates: [
								{
									content: {
										parts: [
											{
												functionCall: {
													id: "call_alpha",
													name: "read_file",
													args: { path: ".nvmrc" },
												},
											},
										],
									},
								},
							],
						},
					]),
				),
			},
		}
		vi.spyOn(handler as any, "ensureClient").mockReturnValue(fakeClient as any)

		const tools = [{ name: "read_file", description: "read file", parameters: { type: "OBJECT" } }] as any
		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], tools)) {
			if (chunk.type === "tool_calls") {
				chunks.push(chunk)
			}
		}

		chunks.should.have.length(1)
		chunks[0].function_id.should.equal("call_alpha")
		chunks[0].provider_metadata.response_id.should.equal("resp_2")
		chunks[0].tool_call.should.not.have.property("call_id")
		chunks[0].tool_call.function.should.not.have.property("id")
		JSON.parse(chunks[0].tool_call.function.arguments).path.should.equal(".nvmrc")
	})
})
