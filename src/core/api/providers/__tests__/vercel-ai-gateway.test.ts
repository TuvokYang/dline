import "should"
import { openRouterDefaultModelId, openRouterDefaultModelInfo } from "@shared/api"
import { ApiProfile } from "@shared/proto/dline/profile"
import { afterEach, describe, expect, it, vi } from "vitest"
import { VercelAIGatewayHandler } from "../vercel-ai-gateway"

describe("VercelAIGatewayHandler", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	const createAsyncIterable = (data: any[] = []) => ({
		[Symbol.asyncIterator]: async function* () {
			yield* data
		},
	})

	describe("getModel", () => {
		it("should return configured model and info when both are provided", () => {
			const customModelInfo = {
				...openRouterDefaultModelInfo,
				capabilities: {
					...openRouterDefaultModelInfo.capabilities,
					maxTokens: 123456,
				},
			}

			const handler = new VercelAIGatewayHandler({
				profile: ApiProfile.create({
					provider: "vercel-ai-gateway",
					modelId: "google/gemini-3.1-pro-preview",
					modelInfo: customModelInfo as any,
				}),
				mode: "act",
			})

			const result = handler.getModel()
			result.id.should.equal("google/gemini-3.1-pro-preview")
			result.info.capabilities?.maxTokens?.should.equal(123456)
			result.info.description?.should.equal(customModelInfo.description)
			result.info.pricing?.inputPrice?.should.equal(customModelInfo.pricing?.inputPrice)
		})

		it("should preserve configured model ID when model info is missing", () => {
			const handler = new VercelAIGatewayHandler({
				profile: ApiProfile.create({ provider: "vercel-ai-gateway", modelId: "google/gemini-3.1-pro-preview" }),
				mode: "act",
			})

			const result = handler.getModel()
			result.id.should.equal("google/gemini-3.1-pro-preview")
			result.info.should.deepEqual({ id: "google/gemini-3.1-pro-preview" })
		})

		it("should fall back to default model when model ID is missing", () => {
			const handler = new VercelAIGatewayHandler({
				profile: ApiProfile.create({ provider: "vercel-ai-gateway" }),
				mode: "act",
			})
			const result = handler.getModel()

			result.id.should.equal(openRouterDefaultModelId)
			result.info.should.deepEqual(openRouterDefaultModelInfo)
		})
	})

	describe("createMessage", () => {
		it("passes an explicit profile disable through the complete gateway reasoning config", async () => {
			const profile = ApiProfile.create({
				provider: "vercel-ai-gateway",
				modelId: "private/opaque",
				modelInfo: {
					id: "private/opaque",
					capabilities: { thinking: { supported: true, mode: "effort", defaultEnabled: true, effortLevels: ["low"] } },
				},
				vercelAiGateway: { reasoning: { enableThinking: false } },
			})
			const handler = new VercelAIGatewayHandler({ profile, mode: "act" })
			const create = vi.fn().mockResolvedValue(createAsyncIterable())
			vi.spyOn(handler as any, "ensureClient").mockReturnValue({ chat: { completions: { create } } })
			for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
			}
			expect(create.mock.calls[0][0].reasoning).toEqual({ enabled: false })
			expect(create.mock.calls[0][0].include_reasoning).toBe(false)
		})

		it("should handle usage-only chunks when delta is missing", async () => {
			const handler = new VercelAIGatewayHandler({
				profile: ApiProfile.create({ provider: "vercel-ai-gateway", apiKey: "test-api-key" }),
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
										prompt_tokens: 11,
										completion_tokens: 7,
									},
								},
							]),
						),
					},
				},
			}
			vi.spyOn(handler as any, "ensureClient").mockReturnValue(fakeClient as any)

			const chunks: any[] = []
			for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
				chunks.push(chunk)
			}

			chunks.should.deepEqual([
				{
					type: "usage",
					cacheWriteTokens: 0,
					cacheReadTokens: 0,
					inputTokens: 11,
					outputTokens: 7,
					totalCost: 0,
				},
			])
		})

		it("should read Anthropic-style cache creation and read tokens from usage chunks", async () => {
			const handler = new VercelAIGatewayHandler({
				profile: ApiProfile.create({ provider: "vercel-ai-gateway", apiKey: "test-api-key" }),
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
										},
										cache_creation_input_tokens: 300,
									},
								},
							]),
						),
					},
				},
			}
			vi.spyOn(handler as any, "ensureClient").mockReturnValue(fakeClient as any)

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
	})
})
