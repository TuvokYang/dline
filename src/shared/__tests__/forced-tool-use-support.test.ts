import { vertexModels } from "@core/api/providers/models/vertex"
import { isClaudeOpusAdaptiveThinkingModel, resolveForcedToolUseSupport } from "@shared/utils/reasoning-support"
import { describe, expect, it } from "vitest"

/**
 * Resolution order for `tool_choice: any` support.
 *
 * A model that rejects a forced choice answers `tool_choice: type "tool" and
 * "any" are not supported for this model` and fails the whole generation, so
 * this has to be decided before the request rather than recovered after it.
 */
describe("forced tool use support", () => {
	it("takes the model's own declaration over any inference", () => {
		// A declaration must win even when the thinking mode would say otherwise,
		// so a remote catalog can correct a model this build never heard of.
		expect(resolveForcedToolUseSupport("claude-opus-5-5", { supportsForcedToolUse: true })).toBe(true)
		expect(
			resolveForcedToolUseSupport("claude-budget-model", {
				supportsForcedToolUse: false,
				thinking: { mode: "budget" },
			}),
		).toBe(false)
		// A declaration is the only way a non-Claude model can opt out, since
		// nothing is inferred for one.
		expect(resolveForcedToolUseSupport("gemini-3-pro", { supportsForcedToolUse: false })).toBe(false)
	})

	it("never infers a refusal for a non-Claude model", () => {
		// Gemini declares effort-mode thinking too, but it has no rule against a
		// forced tool choice; inferring one from the mode alone would silently
		// weaken every Gemini request.
		expect(resolveForcedToolUseSupport("gemini-3-pro", { thinking: { mode: "effort" } })).toBe(true)
		expect(resolveForcedToolUseSupport("gemini-3-pro")).toBe(true)
	})

	it("infers refusal from an undeclared adaptive thinking mode", () => {
		// Adaptive models keep thinking on, and thinking cannot be combined with
		// forced tool use.
		expect(resolveForcedToolUseSupport("claude-opus-5-5", { thinking: { mode: "effort" } })).toBe(false)
	})

	it("keeps the forced choice for an undeclared budget thinking mode", () => {
		expect(resolveForcedToolUseSupport("claude-sonnet-4-5-20250929", { thinking: { mode: "budget" } })).toBe(true)
	})

	it("falls back to the model id when no capabilities are known", () => {
		// User-defined models and legacy profiles carry no capabilities at all.
		expect(resolveForcedToolUseSupport("claude-opus-5-5")).toBe(false)
		expect(resolveForcedToolUseSupport("claude-fable-5-1")).toBe(false)
		expect(resolveForcedToolUseSupport("claude-sonnet-5")).toBe(false)
		expect(resolveForcedToolUseSupport("claude-sonnet-4-5-20250929")).toBe(true)
	})

	it("covers every model the request path already treats as adaptive", () => {
		// The Opus 4.6/4.7/4.8 generation keeps adaptive thinking on, so the
		// request path sends it an effort level. A fallback that recognised only
		// the 5 series would call the same model forceable here and rejectable
		// there, which is the shape of the original 400.
		for (const modelId of ["claude-opus-4-6", "claude-opus-4-7", "claude-opus-4-8"]) {
			expect(isClaudeOpusAdaptiveThinkingModel(modelId)).toBe(true)
			expect(resolveForcedToolUseSupport(modelId)).toBe(false)
		}
	})

	it("covers the Sonnet models of the same generation, not only Opus", () => {
		// The Anthropic catalog declares `claude-sonnet-4-6` adaptive, so a
		// fallback keyed on "opus" would disagree with that declaration for the
		// same model offered through a catalog that omits it, such as Vertex.
		for (const modelId of ["claude-sonnet-4-6", "claude-sonnet-4-6:1m"]) {
			expect(resolveForcedToolUseSupport(modelId)).toBe(false)
		}
	})

	it("agrees with every bundled catalog that declares the model adaptive", () => {
		// The declaration and the fallback answer the same question, so a model
		// declared adaptive in one catalog must not be treated as forceable when
		// another catalog ships the same model without capabilities.
		for (const modelId of [
			"anthropic.claude-sonnet-4-6",
			"anthropic.claude-opus-4-6-v1",
			"anthropic.claude-opus-4-7",
			"us.anthropic.claude-sonnet-4-6-v1:0",
		]) {
			expect(resolveForcedToolUseSupport(modelId)).toBe(false)
		}
	})

	it("recognises an adaptive model behind an aggregator prefix or a dotted version", () => {
		// Vertex, Bedrock, and OpenRouter each rename the same model, and the
		// restriction belongs to the model rather than to the route that sells it.
		expect(resolveForcedToolUseSupport("anthropic/claude-opus-4.6")).toBe(false)
		expect(resolveForcedToolUseSupport("us.anthropic.claude-opus-4-7-v1:0")).toBe(false)
		expect(resolveForcedToolUseSupport("claude-opus-4-6:1m")).toBe(false)
		expect(resolveForcedToolUseSupport("anthropic/claude-opus-5-5")).toBe(false)
	})

	it("reads the Vertex catalog declaration rather than relying on the id fallback", () => {
		// Declaration and fallback must agree, and the declaration is what keeps
		// a renamed model correct when the fallback has not been taught about it.
		for (const modelId of ["claude-sonnet-4-6", "claude-sonnet-4-6:1m", "claude-opus-4-7", "claude-opus-4-7:1m"]) {
			expect(vertexModels[modelId]?.capabilities?.supportsForcedToolUse).toBe(false)
			expect(resolveForcedToolUseSupport(modelId, vertexModels[modelId]?.capabilities)).toBe(false)
		}
	})

	it("treats an unknown model as capable so existing behavior is preserved", () => {
		expect(resolveForcedToolUseSupport(undefined)).toBe(true)
		expect(resolveForcedToolUseSupport("", {})).toBe(true)
		expect(resolveForcedToolUseSupport("some-vendor/some-model", {})).toBe(true)
	})
})
