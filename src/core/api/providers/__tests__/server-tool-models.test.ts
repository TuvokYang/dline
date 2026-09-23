import { ServerTool } from "@shared/proto/dline/models/metadata"
import { describe, expect, it } from "vitest"
import { anthropicModels } from "../models/anthropic"
import { openAiModels } from "../models/openai"
import { openAiCodexModels } from "../models/openai-codex"

describe("built-in hosted Web Search metadata", () => {
	it.each([
		["OpenAI", openAiModels],
		["OpenAI Codex", openAiCodexModels],
		["Anthropic", anthropicModels],
	] as const)("declares WEB_SEARCH for every %s model", (_provider, models) => {
		for (const model of Object.values(models)) {
			expect(model.capabilities?.tools).toContain(ServerTool.WEB_SEARCH)
		}
	})

	it("keeps the OpenAI Codex static catalog on Astra and removes every 5.4 model", () => {
		expect(openAiCodexModels["gpt-6-astra"]).toMatchObject({
			id: "gpt-6-astra",
			name: "GPT-6-Astra",
			capabilities: { contextWindow: 372_000, supportsImages: true },
		})
		expect(Object.keys(openAiCodexModels).filter((modelId) => modelId.startsWith("gpt-5.4"))).toEqual([])
	})

	it("declares the official Claude Opus 5 model metadata", () => {
		const model = anthropicModels["claude-opus-5"]

		expect(model).toBeDefined()
		expect(model).toMatchObject({
			id: "claude-opus-5",
			name: "claude-opus-5",
			capabilities: {
				contextWindow: 1_000_000,
				maxTokens: 128_000,
				supportsImages: true,
				supportsPromptCache: true,
				supportsReasoning: true,
				supportsTools: true,
				// Hosted search and fetch. The sandbox is deliberately not advertised: the
				// account's code execution quota gates it at the provider, so declaring
				// it would offer a capability that cannot currently run.
				tools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
			},
			pricing: {
				inputPrice: 5,
				outputPrice: 25,
				cacheWritesPrice: 6.25,
				cacheReadsPrice: 0.5,
			},
		})
		expect(model.capabilities?.contextWindowTiers).toBeUndefined()
	})
})
