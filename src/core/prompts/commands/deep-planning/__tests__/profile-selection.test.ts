import { describe, expect, it } from "vitest"
import type { ApiProviderInfo } from "@/core/api"
import { PromptProfile } from "../../../profiles/types"
import { getDeepPlanningPrompt } from "../index"
import { DEEP_PLANNING_VARIANTS } from "../variants"

function createProviderInfo(modelId: string): ApiProviderInfo {
	return {
		providerId: "openai",
		model: { id: modelId, info: {} },
		mode: "act",
	} as unknown as ApiProviderInfo
}

describe("deep-planning explicit profile selection", () => {
	it("exposes exactly Standard and Lite variants without model metadata", () => {
		expect(DEEP_PLANNING_VARIANTS.map((variant) => variant.id)).toEqual(["standard", "lite"])
		for (const variant of DEEP_PLANNING_VARIANTS) {
			expect(variant).not.toHaveProperty("family")
			expect(variant).not.toHaveProperty("matcher")
		}
	})

	it("selects distinct Standard and Lite command contracts without model inference", () => {
		const standardFromGpt = getDeepPlanningPrompt(
			PromptProfile.Standard,
			{ enabled: true },
			createProviderInfo("gpt-5.1"),
			false,
		)
		const standardFromOtherModel = getDeepPlanningPrompt(
			PromptProfile.Standard,
			{ enabled: true },
			createProviderInfo("unrelated-model"),
			false,
		)
		const liteFromGpt = getDeepPlanningPrompt(PromptProfile.Lite, { enabled: true }, createProviderInfo("gpt-5.1"), false)
		const liteFromOtherModel = getDeepPlanningPrompt(
			PromptProfile.Lite,
			{ enabled: true },
			createProviderInfo("unrelated-model"),
			false,
		)

		expect(standardFromGpt).toBe(standardFromOtherModel)
		expect(liteFromGpt).toBe(liteFromOtherModel)
		expect(standardFromGpt).not.toBe(liteFromGpt)
	})
})
