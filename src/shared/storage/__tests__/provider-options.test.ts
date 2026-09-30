import {
	normalizeOpenAiServiceTier,
	normalizeOpenaiReasoningEffort,
	OPENAI_COMPATIBLE_REASONING_EFFORT_OPTIONS,
	OPENAI_REASONING_EFFORT_OPTIONS,
	OPENAI_SERVICE_TIER_OPTIONS,
} from "@shared/storage/types"
import { resolveTaskThinkingConfig, validateTaskReasoningOverride } from "@shared/task-reasoning"
import { expect } from "chai"
import { describe, it } from "vitest"

describe("provider reasoning and service-tier options", () => {
	it("does not invent reasoning controls when metadata is unavailable", () => {
		expect(resolveTaskThinkingConfig(undefined)).to.equal(undefined)
	})

	it("preserves a declared empty effort list rather than adding provider defaults", () => {
		const declaration = { supported: true, mode: "effort", effortLevels: [], defaultEnabled: false }
		expect(resolveTaskThinkingConfig({ supportsReasoning: true, thinking: declaration })).to.deep.equal(declaration)
	})

	it("does not infer a budget or effort mode from coarse reasoning support", () => {
		expect(resolveTaskThinkingConfig({ supportsReasoning: true })).to.equal(undefined)
	})

	it("projects declared reasoning without a Profile switch or model identity input", () => {
		const declaration = { supported: true, mode: "effort", canDisable: false, effortLevels: ["declared-effort"] }
		expect(resolveTaskThinkingConfig({ thinking: declaration })).to.deep.equal(declaration)
	})

	it("preserves default and disable declarations without mutating the source", () => {
		const declaration = {
			supported: true,
			mode: "effort",
			defaultEnabled: true,
			canDisable: false,
			defaultEffort: "declared-effort",
			effortLevels: ["declared-effort"],
		}
		const projected = resolveTaskThinkingConfig({ thinking: declaration })
		expect(projected).to.deep.equal(declaration)
		projected?.effortLevels?.push("another-effort")
		expect(declaration.effortLevels).to.deep.equal(["declared-effort"])
	})

	it("does not revive an explicit unsupported declaration", () => {
		expect(
			resolveTaskThinkingConfig({ supportsReasoning: true, thinking: { supported: false, effortLevels: ["high"] } }),
		).to.equal(undefined)
		expect(resolveTaskThinkingConfig({ supportsReasoning: false, thinking: { supported: true } })).to.equal(undefined)
	})

	it("validates a Task effort against the declared list rather than a provider option list", () => {
		const thinking = resolveTaskThinkingConfig({
			thinking: { supported: true, mode: "effort", effortLevels: ["declared-effort"] },
		})
		expect(validateTaskReasoningOverride({ kind: "effort", effort: "declared-effort" }, thinking)).to.deep.equal({
			valid: true,
			override: { kind: "effort", effort: "declared-effort" },
		})
		expect(validateTaskReasoningOverride({ kind: "effort", effort: "high" }, thinking)).to.deep.include({
			valid: false,
			error: "unsupported_effort",
		})
	})

	it("validates a Task budget against the declared bound", () => {
		const thinking = resolveTaskThinkingConfig({ thinking: { supported: true, mode: "budget", maxBudget: 4_096 } })
		expect(validateTaskReasoningOverride({ kind: "budget", budgetTokens: 2_048 }, thinking)).to.deep.equal({
			valid: true,
			override: { kind: "budget", budgetTokens: 2_048 },
		})
		expect(validateTaskReasoningOverride({ kind: "budget", budgetTokens: 4_097 }, thinking)).to.deep.include({
			valid: false,
			error: "budget_exceeds_max",
		})
	})

	it("rejects disabled values when the declaration requires thinking even if a stale list includes none", () => {
		const thinking = resolveTaskThinkingConfig({
			thinking: { supported: true, mode: "effort", canDisable: false, effortLevels: ["none", "high"], maxBudget: 4_096 },
		})
		expect(validateTaskReasoningOverride({ kind: "effort", effort: "none" }, thinking)).to.deep.include({
			valid: false,
			error: "unsupported_effort",
		})
		expect(validateTaskReasoningOverride({ kind: "budget", budgetTokens: 0 }, thinking)).to.deep.include({
			valid: false,
			error: "unsupported_budget",
		})
	})

	it("exposes current OpenAI SDK efforts and compatible ultra effort", () => {
		expect(OPENAI_REASONING_EFFORT_OPTIONS).to.deep.equal(["none", "minimal", "low", "medium", "high", "xhigh", "max"])
		expect(OPENAI_COMPATIBLE_REASONING_EFFORT_OPTIONS).to.deep.equal([...OPENAI_REASONING_EFFORT_OPTIONS, "ultra"])
		expect(normalizeOpenaiReasoningEffort("ultra")).to.equal("ultra")
	})

	it("accepts only OpenAI service tiers supported by the SDK", () => {
		expect(OPENAI_SERVICE_TIER_OPTIONS).to.deep.equal(["auto", "default", "flex", "scale", "priority", "ultrafast"])
		expect(normalizeOpenAiServiceTier("priority")).to.equal("priority")
		expect(normalizeOpenAiServiceTier("ultrafast")).to.equal("ultrafast")
		expect(normalizeOpenAiServiceTier("unsupported")).to.equal(undefined)
	})
})
