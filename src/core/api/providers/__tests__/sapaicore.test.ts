import "should"
import { Anthropic } from "@anthropic-ai/sdk"
import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import type { ReasoningConfig } from "@shared/proto/dline/provider/common"
import {
	bindProviderAttemptScope,
	observeProviderStreamResponse,
	type ProviderAttemptTerminalStatus,
} from "@shared/provider-attempt-observer"
import axios from "axios"
import { afterEach, expect, vi } from "vitest"
import { SapAiCoreHandler } from "../sapaicore"

describe("SapAiCoreHandler", () => {
	let handler: SapAiCoreHandler

	beforeEach(() => {
		handler = new SapAiCoreHandler({
			profile: ApiProfile.create({
				provider: "sapaicore",
				modelId: "anthropic--claude-3.5-sonnet",
				baseUrl: "https://test.api.sap.com",
				sapaicore: {
					clientId: "test-client-id",
					clientSecret: "test-client-secret",
					tokenUrl: "https://test.auth.sap.com",
					resourceGroup: "default",
				},
			}),
			mode: "act",
		})
	})

	describe("image processing", () => {
		// Test image processing through the public interface
		// This tests the complete flow including processImageContent internally

		it("should handle image processing for Claude 4 models", () => {
			// Create handler with Claude 4 model
			const claude4Handler = new SapAiCoreHandler({
				profile: ApiProfile.create({
					provider: "sapaicore",
					modelId: "anthropic--claude-4-sonnet",
					baseUrl: "https://test.api.sap.com",
					sapaicore: {
						clientId: "test-client-id",
						clientSecret: "test-client-secret",
						tokenUrl: "https://test.auth.sap.com",
						resourceGroup: "default",
					},
				}),
				mode: "act",
			})

			const model = claude4Handler.getModel()
			model.id.should.equal("anthropic--claude-4-sonnet")
			model.info.capabilities?.supportsImages?.should.equal(true)
		})

		it("should create proper user readable request with images", () => {
			const testImageData =
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="

			const userContent: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [
				{
					type: "text",
					text: "Here's an image:",
				},
				{
					type: "image",
					source: {
						type: "base64",
						media_type: "image/png",
						data: testImageData,
					},
				},
			]

			const result = handler.createUserReadableRequest(userContent)

			result.should.have.property("model")
			result.should.have.property("max_tokens")
			result.should.have.property("system")
			result.should.have.property("messages")
			result.messages.should.be.Array()
			result.messages[1].should.have.property("role", "user")
			result.messages[1].should.have.property("content", userContent)
		})
	})

	describe("Provider stream lifecycle", () => {
		it("fails only after a non-success deployment response body is fully drained", async () => {
			let tailConsumed = false
			const response = {
				status: 500,
				headers: { "content-type": "application/json" },
				data: (async function* () {
					yield Buffer.from('{"error":"upstream failed"}')
					tailConsumed = true
				})(),
			}
			const statuses: ProviderAttemptTerminalStatus[] = []
			const observer = {
				beginAttempt: () => 1,
				finishAttempt: (_handle: number, status: ProviderAttemptTerminalStatus) => {
					statuses.push(status)
				},
			}
			const privateHandler = handler as unknown as {
				selectDeploymentStream(value: typeof response): AsyncIterable<unknown> | undefined
			}
			const source = (async function* () {
				const { stream } = await observeProviderStreamResponse(
					async () => response,
					(value) => privateHandler.selectDeploymentStream(value),
				)
				if (!stream) throw new Error("Expected a failed deployment stream")
				for await (const chunk of stream) yield chunk
			})()
			let caught: unknown

			try {
				for await (const _chunk of bindProviderAttemptScope(source, observer)) {
					// The failed stream does not produce model chunks.
				}
			} catch (error) {
				caught = error
			}

			tailConsumed.should.equal(true)
			statuses.should.deepEqual(["failed"])
			if (!(caught instanceof Error) || !("response" in caught)) throw new Error("Expected a response-bearing error")
			const errorResponse = (caught as Error & { response: { status: number; data: string } }).response
			errorResponse.status.should.equal(500)
			errorResponse.data.should.equal('{"error":"upstream failed"}')
		})

		it("drains the GPT transport stream to EOF after the protocol DONE event", async () => {
			let tailConsumed = false
			const stream = (async function* () {
				yield Buffer.from("data: [DONE]\n")
				tailConsumed = true
				yield Buffer.from('data: {"ignored":true}\n')
			})()
			const chunks: unknown[] = []
			const privateHandler = handler as unknown as {
				streamCompletionGPT(
					source: AsyncIterable<Buffer>,
					model: ReturnType<SapAiCoreHandler["getModel"]>,
				): AsyncIterable<unknown>
			}

			for await (const chunk of privateHandler.streamCompletionGPT(stream, handler.getModel())) chunks.push(chunk)

			tailConsumed.should.equal(true)
			chunks.should.deepEqual([{ type: "usage", inputTokens: 0, outputTokens: 0 }])
		})
	})

	describe("getModel", () => {
		it("should return specified model when apiModelId is provided", () => {
			const customHandler = new SapAiCoreHandler({
				profile: ApiProfile.create({ provider: "sapaicore", modelId: "anthropic--claude-4-sonnet" }),
				mode: "act",
			})

			const result = customHandler.getModel()
			result.id.should.equal("anthropic--claude-4-sonnet")
		})
	})

	describe("createUserReadableRequest", () => {
		it("should create a readable request format", () => {
			const userContent: Anthropic.TextBlockParam[] = [
				{
					type: "text",
					text: "Hello, world!",
				},
			]

			const result = handler.createUserReadableRequest(userContent)

			result.should.have.property("model")
			result.should.have.property("max_tokens")
			result.should.have.property("system")
			result.should.have.property("messages")
			result.should.have.property("tools")
			result.should.have.property("tool_choice")
		})
	})
})

describe("SAP OpenAI metadata authority", () => {
	afterEach(() => vi.restoreAllMocks())

	const declared: ModelCapabilities = {
		maxTokens: 29,
		contextWindow: 71,
		thinking: { supported: true, mode: "effort", effortLevels: ["none", "high", "xhigh"] },
	}
	const cases: {
		name: string
		capabilities: ModelCapabilities
		reasoning?: ReasoningConfig
		modelId?: string
		effort?: string
	}[] = [
		{
			name: "missing declaration on a misleading name",
			capabilities: { supportsReasoning: true },
			reasoning: { effort: "high" },
		},
		{ name: "coarse false veto", capabilities: { ...declared, supportsReasoning: false }, reasoning: { effort: "high" } },
		{
			name: "nested false veto",
			capabilities: { thinking: { supported: false, mode: "effort", effortLevels: ["high"] } },
			reasoning: { effort: "high" },
		},
		{ name: "legal effort", capabilities: declared, reasoning: { effort: "high" }, effort: "high" },
		{ name: "invalid effort", capabilities: declared, reasoning: { effort: "invalid" } },
		{
			name: "empty legal list",
			capabilities: { thinking: { supported: true, mode: "effort", effortLevels: [] } },
			reasoning: { effort: "high" },
		},
		{
			name: "explicit disable",
			capabilities: declared,
			reasoning: { enableThinking: false, effort: "high" },
			effort: "none",
		},
		{
			name: "required rejects stale disable",
			capabilities: { thinking: { ...declared.thinking, canDisable: false } },
			reasoning: { enableThinking: false, effort: "none" },
		},
		{
			name: "declared default",
			capabilities: { thinking: { ...declared.thinking, defaultEnabled: true, defaultEffort: "high" } },
			effort: "high",
		},
		{ name: "legacy max alias", capabilities: declared, reasoning: { effort: "max" }, effort: "xhigh" },
		{
			name: "declaration independent of wire name",
			modelId: "gpt-4o",
			capabilities: declared,
			reasoning: { effort: "high" },
			effort: "high",
		},
	]

	it.each(cases)("encodes $name in a deployment request", async ({ capabilities, reasoning, modelId = "gpt-5", effort }) => {
		const profile = ApiProfile.create({
			provider: "sapaicore",
			modelId,
			modelInfo: { id: modelId, capabilities, pricing: { inputPrice: 0 }, userDefined: true },
			baseUrl: "https://test.api.sap.invalid",
			sapaicore: { resourceGroup: "test-group", reasoning },
		})
		const current = new SapAiCoreHandler({ profile, mode: "act" })
		Object.defineProperty(current, "getToken", { value: async () => "test-token" })
		const getDeploymentForModel = vi.fn(async (_modelId: string) => "deployment-test")
		Object.defineProperty(current, "getDeploymentForModel", { value: getDeploymentForModel })
		const post = vi.spyOn(axios, "post").mockResolvedValue({
			status: 200,
			headers: {},
			data: (async function* () {
				yield Buffer.from("data: [DONE]\n")
			})(),
		})
		const chunks = []
		for await (const chunk of current.createMessage("system", [{ role: "user", content: "hi" }])) chunks.push(chunk)
		expect(chunks).toEqual([{ type: "usage", inputTokens: 0, outputTokens: 0 }])
		expect(getDeploymentForModel.mock.calls).toEqual([[modelId]])
		expect(post.mock.calls[0][0]).toBe(
			"https://test.api.sap.invalid/v2/inference/deployments/deployment-test/chat/completions?api-version=2024-12-01-preview",
		)
		const body = post.mock.calls[0][1]
		if (typeof body !== "string") throw new Error("Expected the serialized deployment payload")
		const payload = JSON.parse(body)
		expect(payload).toMatchObject({
			stream: true,
			messages: [
				{ role: "system", content: "system" },
				{ role: "user", content: "hi" },
			],
			temperature: 0,
			stream_options: { include_usage: true },
		})
		expect(payload.reasoning_effort).toBe(effort)
		if (modelId === "gpt-4o") expect(payload.max_tokens).toBe(capabilities.maxTokens)
		else expect(payload).not.toHaveProperty("max_tokens")
		expect(current.getModel()).toEqual({ id: modelId, info: profile.modelInfo })
	})

	it("preserves unknown identity instead of substituting a supported deployment", () => {
		const current = new SapAiCoreHandler({
			profile: ApiProfile.create({
				provider: "sapaicore",
				modelId: "private-unknown-test",
				modelInfo: { id: "gpt-5", capabilities: declared },
			}),
			mode: "act",
		})
		expect(current.getModel()).toEqual({ id: "private-unknown-test", info: { id: "private-unknown-test" } })
	})
})
