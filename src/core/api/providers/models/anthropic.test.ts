import { describe, expect, it } from "vitest"
import { anthropicModels } from "./anthropic"

describe("Anthropic model thinking metadata", () => {
	it("declares xhigh, max, and an explicit disabled option for supported models", () => {
		const modelIds = [
			"claude-opus-5-5",
			"claude-opus-5",
			"claude-opus-5:fast",
			"claude-opus-4-8",
			"claude-opus-4-8:fast",
			"claude-sonnet-5",
			"claude-opus-4-7",
		]

		for (const modelId of modelIds) {
			expect(anthropicModels[modelId]?.capabilities?.thinking).toEqual({
				supported: true,
				mode: "effort",
				effortLevels: ["none", "low", "medium", "high", "xhigh", "max"],
			})
		}
	})

	it("prices Claude Opus 5.5 below Opus 5 while keeping its capabilities", () => {
		const opus55 = anthropicModels["claude-opus-5-5"]
		const opus5 = anthropicModels["claude-opus-5"]

		expect(opus55?.pricing).toEqual({
			inputPrice: 4.0,
			outputPrice: 20.0,
			cacheWritesPrice: 5.0,
			cacheReadsPrice: 0.2,
		})
		expect(opus55?.capabilities).toEqual(opus5?.capabilities)
	})

	it("keeps Fable 5 adaptive thinking enabled without a disabled option", () => {
		expect(anthropicModels["claude-fable-5"]?.capabilities?.thinking).toEqual({
			supported: true,
			mode: "effort",
			effortLevels: ["low", "medium", "high", "xhigh", "max"],
		})
	})

	it("declares max without xhigh for Claude 4.6 models", () => {
		for (const modelId of ["claude-sonnet-4-6", "claude-opus-4-6"]) {
			expect(anthropicModels[modelId]?.capabilities?.thinking).toEqual({
				supported: true,
				mode: "effort",
				effortLevels: ["none", "low", "medium", "high", "max"],
			})
		}
	})
})
