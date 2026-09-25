import { describe, expect, it } from "vitest"
import { getPrompt, renderPrompt } from "./index"

describe("prompt i18n registry", () => {
	it("resolves InputQueue guidance in Simplified Chinese and falls back to English for other languages", () => {
		const english = getPrompt("inputQueue", "auxiliaryAlignmentV1", "en")
		const simplifiedChinese = getPrompt("inputQueue", "auxiliaryAlignmentV1", "zh-CN")
		const japaneseFallback = getPrompt("inputQueue", "auxiliaryAlignmentV1", "ja")

		expect(english).toContain("auxiliary alignment information")
		expect(simplifiedChinese).toContain("辅助对齐信息")
		expect(japaneseFallback).toBe(english)
	})

	it("renders declared parameters through the immutable environment chain", () => {
		const prompt = renderPrompt("toolHandlers", "missingToolParameterError", {
			PARAM_NAME: "command",
			TOOL_REMINDER: "Use the tool schema.",
		})

		expect(prompt).toContain("command")
		expect(prompt).toContain("Use the tool schema.")
		expect(prompt).not.toContain("[MISSING:")
	})
})
