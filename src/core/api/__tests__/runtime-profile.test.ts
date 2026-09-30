import type { ApiConfiguration } from "@shared/api"
import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import { applyTaskRuntimeOverrides } from "../runtime-profile"

function createOpenAiProfile(): ApiProfile {
	return ApiProfile.create({
		id: "profile-1",
		name: "OpenAI profile",
		provider: "openai",
		modelId: "gpt-test",
		enabled: true,
		modelInfo: {
			capabilities: {
				thinking: {
					supported: true,
					effortLevels: ["none", "low", "medium", "high"],
					maxBudget: 8_192,
				},
			},
		},
		openai: {
			reasoning: { enableThinking: true, effort: "medium" },
			serviceTier: "default",
		},
	})
}

describe("Task runtime Profile overrides", () => {
	it("applies only the selected mode overrides without mutating the Catalog Profile", () => {
		const profile = createOpenAiProfile()
		const configuration: ApiConfiguration = {
			planModeReasoningOverride: { kind: "effort", effort: "low" },
			actModeReasoningOverride: { kind: "effort", effort: "high" },
			planModeServiceTierOverride: { kind: "tier", tier: "flex" },
			actModeServiceTierOverride: { kind: "tier", tier: "priority" },
		}

		const runtimeProfile = applyTaskRuntimeOverrides(profile, configuration, "act")

		expect(runtimeProfile).not.toBe(profile)
		expect(runtimeProfile.openai).not.toBe(profile.openai)
		expect(runtimeProfile.openai?.reasoning).toEqual({
			enableThinking: true,
			effort: "high",
			thinkingBudget: undefined,
		})
		expect(runtimeProfile.openai?.serviceTier).toBe("priority")
		expect(profile.openai?.reasoning?.effort).toBe("medium")
		expect(profile.openai?.serviceTier).toBe("default")
	})

	it("applies declared DeepSeek efforts at the runtime handler boundary", () => {
		const profile = ApiProfile.create({
			id: "profile-deepseek",
			name: "DeepSeek profile",
			provider: "deepseek",
			modelId: "deepseek-v4-flash",
			enabled: true,
			modelInfo: {
				capabilities: {
					supportsReasoning: true,
					thinking: { supported: true, mode: "effort", effortLevels: ["high", "max"] },
				},
			},
			deepseek: {
				reasoning: { enableThinking: true, effort: "high" },
			},
		})

		const runtimeProfile = applyTaskRuntimeOverrides(
			profile,
			{ actModeReasoningOverride: { kind: "effort", effort: "max" } },
			"act",
		)

		expect(runtimeProfile.deepseek?.reasoning).toMatchObject({ enableThinking: true, effort: "max" })
		expect(profile.deepseek?.reasoning?.effort).toBe("high")
	})

	it("preserves Profile values when the Task inherits both controls", () => {
		const profile = createOpenAiProfile()
		const runtimeProfile = applyTaskRuntimeOverrides(
			profile,
			{
				actModeReasoningOverride: { kind: "inherit" },
				actModeServiceTierOverride: { kind: "inherit" },
			},
			"act",
		)

		expect(runtimeProfile).not.toBe(profile)
		expect(runtimeProfile.openai?.reasoning?.effort).toBe("medium")
		expect(runtimeProfile.openai?.serviceTier).toBe("default")
	})

	it("does not admit overrides through misleading model names or an enabled Profile preference", () => {
		const profile = createOpenAiProfile()
		profile.modelId = "gpt-claude-deepseek-test"
		profile.modelInfo = { id: profile.modelId, capabilities: { supportsReasoning: true } }
		expect(() =>
			applyTaskRuntimeOverrides(profile, { actModeReasoningOverride: { kind: "effort", effort: "high" } }, "act"),
		).toThrow("Reasoning effort 'high' is not supported by the selected model.")
	})

	it("rejects a reasoning override not advertised by the selected model", () => {
		const profile = createOpenAiProfile()

		expect(() =>
			applyTaskRuntimeOverrides(profile, { actModeReasoningOverride: { kind: "effort", effort: "xhigh" } }, "act"),
		).toThrow("Reasoning effort 'xhigh' is not supported by the selected model.")
	})

	it("rejects a service tier override for a non-OpenAI provider", () => {
		const profile = ApiProfile.create({
			id: "profile-2",
			name: "Anthropic profile",
			provider: "anthropic",
			modelId: "claude-test",
			enabled: true,
		})

		expect(() =>
			applyTaskRuntimeOverrides(profile, { actModeServiceTierOverride: { kind: "tier", tier: "priority" } }, "act"),
		).toThrow("Service tier is not supported by provider 'anthropic'.")
	})
})
