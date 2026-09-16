import { ApiProfile } from "@shared/proto/dline/profile"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	createOpenAIClient: vi.fn(),
}))

vi.mock("@shared/net", () => ({
	createOpenAIClient: mocks.createOpenAIClient,
}))

import { CerebrasHandler } from "../cerebras"

const createAsyncIterable = (data: readonly unknown[] = []) => ({
	[Symbol.asyncIterator]: async function* streamChunks() {
		yield* data
	},
})

async function collectStream(stream: AsyncIterable<unknown>): Promise<unknown[]> {
	const chunks: unknown[] = []
	for await (const chunk of stream) {
		chunks.push(chunk)
	}
	return chunks
}

function createHandler(profile: { apiKey?: string; modelId?: string; baseUrl?: string } = {}) {
	return new CerebrasHandler({
		profile: ApiProfile.create({
			provider: "cerebras",
			apiKey: "test-api-key",
			modelId: "gpt-oss-120b",
			...profile,
		}),
		mode: "act",
	})
}

describe("CerebrasHandler", () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it("uses the shared OpenAI client and preserves the Cerebras request contract", async () => {
		const create = vi.fn().mockResolvedValue(createAsyncIterable())
		mocks.createOpenAIClient.mockReturnValue({ chat: { completions: { create } } })
		const handler = createHandler({ apiKey: "  secret  " })

		await collectStream(handler.createMessage("system prompt", [{ role: "user", content: "hello" }]))

		expect(mocks.createOpenAIClient).toHaveBeenCalledWith({
			baseURL: "https://api.cerebras.ai/v1",
			apiKey: "secret",
			timeout: 30000,
			defaultHeaders: {
				"X-Cerebras-3rd-Party-Integration": "cline",
			},
		})
		expect(create).toHaveBeenCalledWith({
			model: "gpt-oss-120b",
			messages: [
				{ role: "system", content: "system prompt" },
				{ role: "user", content: "hello" },
			],
			temperature: 0,
			stream: true,
			max_tokens: 16_384,
		})
	})

	it("projects OpenAI-compatible text and usage chunks into the existing ApiStream contract", async () => {
		const create = vi.fn().mockResolvedValue(
			createAsyncIterable([
				{ choices: [{ delta: { content: "hello" } }] },
				{
					choices: [],
					usage: {
						prompt_tokens: 12,
						completion_tokens: 4,
						total_tokens: 16,
					},
				},
			]),
		)
		mocks.createOpenAIClient.mockReturnValue({ chat: { completions: { create } } })

		const chunks = await collectStream(createHandler().createMessage("system", [{ role: "user", content: "hi" }]))

		expect(chunks).toEqual([
			{ type: "text", text: "hello" },
			expect.objectContaining({
				type: "usage",
				inputTokens: 12,
				outputTokens: 4,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
			}),
		])
	})

	it("preserves Qwen model mapping, history cleanup, and reasoning stream projection", async () => {
		const create = vi
			.fn()
			.mockResolvedValue(
				createAsyncIterable([
					{ choices: [{ delta: { content: "<think>plan" } }] },
					{ choices: [{ delta: { content: " complete</think>" } }] },
					{ choices: [{ delta: { content: "answer" } }] },
				]),
			)
		mocks.createOpenAIClient.mockReturnValue({ chat: { completions: { create } } })
		const handler = createHandler({ modelId: "qwen-3-coder-480b-free" })

		const chunks = await collectStream(
			handler.createMessage("system", [
				{
					role: "user",
					content: [
						{ type: "text", text: "question" },
						{ type: "image", source: { type: "base64", media_type: "image/png", data: "aW1hZ2U=" } },
					],
				},
				{ role: "assistant", content: [{ type: "text", text: "<think>hidden</think> prior answer" }] },
			]),
		)

		expect(create).toHaveBeenCalledWith(
			expect.objectContaining({
				model: "qwen-3-coder-480b",
				messages: [
					{ role: "system", content: "system" },
					{ role: "user", content: "question\n[Image content not supported in Cerebras]" },
					{ role: "assistant", content: "prior answer" },
				],
			}),
		)
		expect(chunks).toEqual([
			{ type: "reasoning", reasoning: "plan" },
			{ type: "reasoning", reasoning: " complete" },
			{ type: "text", text: "answer" },
		])
	})
})
