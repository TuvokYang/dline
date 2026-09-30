import "should"
import { openRouterDefaultModelInfo } from "@shared/api"
import { ApiProfile } from "@shared/proto/dline/profile"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ClineAccountService } from "@/services/account/ClineAccountService"
import { AuthService } from "@/services/auth/AuthService"
import { ClineHandler } from "../cline"

describe("ClineHandler", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	const createAsyncIterable = (data: any[] = []) => ({
		[Symbol.asyncIterator]: async function* () {
			yield* data
		},
	})

	const createHandler = (options: ConstructorParameters<typeof ClineHandler>[0]) => {
		vi.spyOn(ClineAccountService, "getInstance").mockReturnValue({} as any)
		vi.spyOn(AuthService, "getInstance").mockReturnValue({} as any)
		return new ClineHandler(options)
	}

	it("does not lend the default model's declaration to an unknown selected alias", () => {
		const handler = createHandler({
			profile: ApiProfile.create({ provider: "cline", modelId: "private/unknown" }),
			mode: "act",
		})
		handler.getModel().should.deepEqual({ id: "private/unknown", info: { id: "private/unknown" } })
	})

	it("passes an explicit profile disable through the complete gateway reasoning config", async () => {
		const profile = ApiProfile.create({
			provider: "cline",
			modelId: "private/opaque",
			modelInfo: {
				capabilities: { thinking: { supported: true, mode: "effort", defaultEnabled: true, effortLevels: ["low"] } },
			},
			clineProvider: { reasoning: { enableThinking: false } },
		})
		const handler = createHandler({ profile, mode: "act" })
		const create = vi.fn().mockResolvedValue(createAsyncIterable())
		vi.spyOn(handler as any, "ensureClient").mockResolvedValue({ chat: { completions: { create } } })
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
		}
		expect(create.mock.calls[0][0].reasoning).toEqual({ enabled: false })
		expect(create.mock.calls[0][0].include_reasoning).toBe(false)
	})

	it("should handle usage-only chunks when delta is missing", async () => {
		const handler = createHandler({ profile: ApiProfile.create({ provider: "cline" }), mode: "act" })
		const fakeClient = {
			chat: {
				completions: {
					create: vi.fn().mockResolvedValue(
						createAsyncIterable([
							{
								choices: [{}],
								usage: {
									prompt_tokens: 17,
									completion_tokens: 9,
								},
							},
						]),
					),
				},
			},
		}
		vi.spyOn(handler as any, "ensureClient").mockResolvedValue(fakeClient as any)
		vi.spyOn(handler, "getModel").mockReturnValue({
			id: "openai/gpt-4o-mini",
			info: openRouterDefaultModelInfo,
		})

		const chunks: any[] = []
		for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
			chunks.push(chunk)
		}

		chunks.should.deepEqual([
			{
				type: "usage",
				cacheWriteTokens: 0,
				cacheReadTokens: 0,
				inputTokens: 17,
				outputTokens: 9,
				totalCost: 0,
			},
		])
	})

	it("should read Anthropic-style cache creation and read tokens from usage chunks", async () => {
		const handler = createHandler({ profile: ApiProfile.create({ provider: "cline" }), mode: "act" })
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
		vi.spyOn(handler as any, "ensureClient").mockResolvedValue(fakeClient as any)
		vi.spyOn(handler, "getModel").mockReturnValue({
			id: "anthropic/claude-sonnet-4.6",
			info: openRouterDefaultModelInfo,
		})

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

	it("should forward enableParallelToolCalling to OpenRouter payload", async () => {
		const handler = createHandler({
			profile: ApiProfile.create({ provider: "cline" }),
			mode: "act",
			enableParallelToolCalling: true,
		})
		const createStub = vi.fn().mockResolvedValue(createAsyncIterable([]))
		const fakeClient = {
			chat: {
				completions: {
					create: createStub,
				},
			},
		}
		vi.spyOn(handler as any, "ensureClient").mockResolvedValue(fakeClient as any)
		vi.spyOn(handler, "getModel").mockReturnValue({
			id: "openai/gpt-4o-mini",
			info: openRouterDefaultModelInfo,
		})

		const tools = [
			{ type: "function", function: { name: "read_file", description: "", parameters: { type: "object" } } },
		] as any
		for await (const _chunk of handler.createMessage("system", [{ role: "user", content: "hi" }], tools)) {
			// drain stream
		}

		const payload = createStub.mock.calls[0][0]
		payload.parallel_tool_calls.should.equal(true)
	})
})
