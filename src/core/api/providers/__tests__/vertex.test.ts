import "should"
import type { ApiHandlerContext } from "@core/api"
import { ApiProfile } from "@shared/proto/dline/profile"
import { expect, vi } from "vitest"
import { GeminiHandler } from "../gemini"
import { VertexHandler } from "../vertex"

describe("VertexHandler", () => {
	it("preserves Vertex reasoning when delegating an effective Gemini model", async () => {
		const profile = ApiProfile.create({
			provider: "vertex",
			modelId: "gemini-private-alias",
			modelInfo: {
				id: "gemini-private-alias",
				capabilities: { thinking: { supported: true, mode: "budget", maxBudget: 2000 } },
			},
			vertex: { reasoning: { thinkingBudget: 1500 } },
		})
		const context = { profile, mode: "act" as const }
		const gemini = new GeminiHandler(context)
		const generateContentStream = vi.fn().mockResolvedValue((async function* () {})())
		;(gemini as unknown as { client: unknown }).client = { models: { generateContentStream } }
		const handler = new VertexHandler(context)
		;(handler as unknown as { geminiHandler: GeminiHandler }).geminiHandler = gemini
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
		}
		const request = generateContentStream.mock.calls[0][0]
		expect(request.model).toBe(profile.modelId)
		expect(request.config.thinkingConfig.thinkingBudget).toBe(1500)
	})

	it("disables Anthropic SDK internal retries so outer retries remain separate sends", () => {
		const handler = new VertexHandler({
			profile: {
				provider: "vertex",
				modelId: "claude-sonnet-4-5@20250929",
				vertex: {
					vertexProjectId: "test-project",
					vertexRegion: "us-east5",
				},
			},
			mode: "act",
		} as unknown as ApiHandlerContext)
		const options = (
			handler as unknown as {
				createAnthropicClientOptions(headers: Record<string, string>): { maxRetries: number }
			}
		).createAnthropicClientOptions({})

		options.maxRetries.should.equal(0)
	})
})
