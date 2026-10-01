import { ClaudeCodeHandler } from "@core/api/providers/claude-code"
import type { ModelInfo } from "@shared/api"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
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
		expect(createHandler("claude-sonnet-5").getModel().id).toBe("claude-sonnet-5")
	})

	it("falls back to the default model when none is configured", () => {
		const model = createHandler().getModel()

		expect(typeof model.id).toBe("string")
		expect(model.id.length).toBeGreaterThan(0)
		expect(model.info).toBeTypeOf("object")
	})

	// The settings page can offer a remotely discovered model that the bundled
	// catalog does not know. Substituting the default here would silently bill
	// a different model than the one the user selected, so a configured ID has
	// to survive even when it is absent from the catalog.
	it("keeps a selected model the bundled catalog does not know", () => {
		expect(createHandler("claude-opus-9-1-20991231").getModel().id).toBe("claude-opus-9-1-20991231")
	})

	it("preserves complete effective Profile metadata instead of treating declarations as overrides", () => {
		const info = {
			id: "opaque-model",
			name: "Effective model",
			apiFormats: [ApiFormat.ANTHROPIC_CHAT],
			capabilities: {
				supportsForcedToolUse: false,
				tools: [ServerTool.WEB_SEARCH],
				thinking: { supported: true, mode: "effort", canDisable: false, defaultEnabled: true, effortLevels: ["high"] },
			},
		}
		const model = createHandlerWithModelInfo(info.id, info).getModel()
		expect(model.info).toMatchObject(info)
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

	it("lets the handler carry hosted web search and web fetch", () => {
		const handler = createHandler()

		expect(handler.supportsServerTool(ServerTool.WEB_SEARCH)).toBe(true)
		expect(handler.supportsServerTool(ServerTool.WEB_FETCH)).toBe(true)
		expect(handler.supportsServerTool(ServerTool.CODE_EXECUTION)).toBe(false)
	})
})
