import { ClaudeCodeHandler } from "@core/api/providers/claude-code"
import { claudeCodeModels } from "@core/api/providers/models/claude-code"
import type { ModelInfo } from "@shared/api"
import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"

function createHandler(modelId?: string): ClaudeCodeHandler {
	return new ClaudeCodeHandler({
		profile: ApiProfile.create({ provider: "claude-code", ...(modelId ? { modelId } : {}) }),
		mode: "act",
	})
}

/** Build a handler for a model whose metadata the Profile carries itself. */
function createHandlerWithModelInfo(modelId: string, modelInfo: Partial<ModelInfo>): ClaudeCodeHandler {
	return new ClaudeCodeHandler({
		profile: ApiProfile.create({ provider: "claude-code", modelId, modelInfo: modelInfo as never }),
		mode: "act",
	})
}

describe("ClaudeCodeHandler model resolution", () => {
	it("returns the configured model", () => {
		expect(createHandler("claude-sonnet-4-5-20250929").getModel().id).toBe("claude-sonnet-4-5-20250929")
	})

	it("falls back to the default model when none is configured", () => {
		const model = createHandler().getModel()

		expect(typeof model.id).toBe("string")
		expect(model.id.length).toBeGreaterThan(0)
		expect(model.info).toBeTypeOf("object")
	})

	it.each([
		["claude-opus-5-5", 1_000_000],
		["claude-opus-4-7", 1_000_000],
		["claude-sonnet-4-6", 1_000_000],
		["claude-sonnet-4-5-20250929", 200_000],
		["claude-haiku-4-5-20251001", 200_000],
	])("resolves %s to a %i token context window", (modelId, contextWindow) => {
		const model = createHandler(modelId).getModel()

		expect(model.id).toBe(modelId)
		expect(model.info.capabilities?.contextWindow).toBe(contextWindow)
	})

	it("defaults to the current flagship model", () => {
		expect(createHandler().getModel().id).toBe("claude-opus-5-5")
	})

	// The settings page can offer a remotely discovered model that the bundled
	// catalog does not know. Substituting the default here would silently bill
	// a different model than the one the user selected, so a configured ID has
	// to survive even when it is absent from the catalog.
	it("keeps a selected model the bundled catalog does not know", () => {
		expect(createHandler("claude-opus-9-1-20991231").getModel().id).toBe("claude-opus-9-1-20991231")
	})

	it("keeps the Profile metadata of a remotely discovered model", () => {
		const model = createHandlerWithModelInfo("claude-opus-9-1-20991231", {
			id: "claude-opus-9-1-20991231",
			capabilities: { contextWindow: 500_000, maxTokens: 64_000 },
		}).getModel()

		expect(model.id).toBe("claude-opus-9-1-20991231")
		expect(model.info.capabilities?.contextWindow).toBe(500_000)
		expect(model.info.capabilities?.maxTokens).toBe(64_000)
	})

	// The metered 1M window and the CLI's bare selectors are not part of a
	// subscription, so offering either would let the user pick a model whose
	// requests the plan cannot satisfy.
	it("offers neither long-context variants nor CLI aliases", () => {
		const offered = Object.keys(claudeCodeModels)

		expect(offered.filter((id) => id.includes("[1m]"))).toEqual([])
		expect(offered).not.toContain("sonnet")
		expect(offered).not.toContain("opus")
	})

	// Anthropic retires a model outright: requests to it fail rather than
	// degrade, so a retired entry in the picker is a guaranteed failed request
	// dressed up as a choice.
	it("offers no model Anthropic has already retired", () => {
		const retired = [
			"claude-opus-4-1-20250805",
			"claude-opus-4-20250514",
			"claude-sonnet-4-20250514",
			"claude-3-7-sonnet-20250219",
			"claude-3-5-haiku-20241022",
			"claude-3-haiku-20240307",
		]

		expect(Object.keys(claudeCodeModels).filter((id) => retired.includes(id))).toEqual([])
	})
})

describe("ClaudeCodeHandler subscription capabilities", () => {
	// The former CLI transport could not carry image blocks and disabled prompt
	// caching. Direct Messages API access removes both limits, so a regression
	// back to the CLI-era metadata would silently degrade the provider.
	it("no longer declares the CLI-era image and prompt-cache restrictions", () => {
		const capabilities = createHandler("claude-sonnet-4-5-20250929").getModel().info.capabilities

		expect(capabilities?.supportsImages).toBe(true)
		expect(capabilities?.supportsPromptCache).toBe(true)
	})

	// The CLI parsed tool calls itself, so the catalog never declared native tool
	// support. Over HTTP an undeclared capability means no tools reach the
	// request and the model can only answer in prose.
	it("declares native tool support for every offered model", () => {
		const withoutTools = Object.entries(claudeCodeModels)
			.filter(([, info]) => info.capabilities?.supportsTools !== true)
			.map(([id]) => id)

		expect(withoutTools).toEqual([])
	})

	it("declares an output budget beyond the former CLI cap", () => {
		const capabilities = createHandler("claude-sonnet-4-5-20250929").getModel().info.capabilities

		expect(capabilities?.maxTokens ?? 0).toBeGreaterThan(8192)
	})
})
