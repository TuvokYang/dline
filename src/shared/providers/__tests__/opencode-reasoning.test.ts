import type { ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { OpenCodeProviderConfig } from "@shared/proto/dline/provider/opencode"
import { applyTaskReasoningOverride, resolveProfileReasoningConfig } from "@shared/task-reasoning"
import { describe, expect, it } from "vitest"
import { resolveOpenCodeReasoningConfig } from "../opencode-reasoning"

const capabilities: ModelCapabilities = {
    supportsReasoning: true,
    thinking: { supported: true, mode: "effort", effortLevels: ["low", "medium", "high", "xhigh", "max"] },
}

describe("OpenCode Profile reasoning policy", () => {
    it("uses the existing second-highest default without persisting a preference", () => {
        const profile = ApiProfile.create({ provider: "opencode", modelInfo: { id: "remote", capabilities }, opencode: {} })
        expect(resolveProfileReasoningConfig(profile)).toEqual({ enableThinking: true, effort: "xhigh" })
        expect(profile.opencode?.reasoning).toBeUndefined()
        expect(capabilities.thinking).not.toHaveProperty("defaultEffort")
    })

    it("preserves an explicit preference through encode/decode instead of replacing it with a derived default", () => {
        const profile = ApiProfile.create({
            provider: "opencode",
            opencode: { reasoning: { enableThinking: true, effort: "low" }, model: { reasoning: { effort: "max" } } },
        })
        const restored = ApiProfile.decode(ApiProfile.encode(profile).finish())
        expect(resolveProfileReasoningConfig(restored, capabilities)).toEqual({ enableThinking: true, effort: "low" })
    })

    it("keeps explicit disabling and a zero budget rather than re-enabling thinking", () => {
        const stored = { enableThinking: false, effort: "none", thinkingBudget: 0 }
        expect(resolveOpenCodeReasoningConfig(capabilities, stored)).toEqual(stored)
        expect(stored).toEqual({ enableThinking: false, effort: "none", thinkingBudget: 0 })
    })

    it.each([{ effortLevels: [] }, { effortLevels: ["high"] }])("handles a zero- or single-level declaration $effortLevels", ({
        effortLevels,
    }) => {
        const resolved = resolveOpenCodeReasoningConfig(
            { thinking: { supported: true, mode: "effort", effortLevels } },
            undefined,
        )
        expect(resolved).toEqual({ enableThinking: true, effort: effortLevels.length ? "high" : undefined })
    })

    it("does not invent reasoning when the effective model rejects or omits it", () => {
        expect(resolveOpenCodeReasoningConfig(undefined, undefined)).toBeUndefined()
        expect(resolveOpenCodeReasoningConfig({ ...capabilities, supportsReasoning: false }, undefined)).toBeUndefined()
        expect(resolveOpenCodeReasoningConfig({ thinking: { supported: false } }, undefined)).toBeUndefined()
    })

    it("uses legacy settings only as a fallback and applies a Task override to a clone", () => {
        const profile = ApiProfile.create({
            provider: "opencode",
            opencode: OpenCodeProviderConfig.create({ mode: 2, model: { reasoning: { enableThinking: true, effort: "high" } } }),
        })
        expect(resolveProfileReasoningConfig(profile, capabilities)?.effort).toBe("high")
        const inherited = applyTaskReasoningOverride(profile, { kind: "inherit" })
        expect(resolveProfileReasoningConfig(inherited, capabilities)?.effort).toBe("high")
        const runtime = applyTaskReasoningOverride(profile, { kind: "effort", effort: "medium" })
        expect(resolveProfileReasoningConfig(runtime, capabilities)?.effort).toBe("medium")
        expect(resolveProfileReasoningConfig(profile, capabilities)?.effort).toBe("high")
        expect(runtime.opencode?.mode).toBe(2)
    })

    it("keeps budget and other providers' policies independent from the effort default", () => {
        expect(
            resolveOpenCodeReasoningConfig({ thinking: { supported: true, mode: "budget" } }, { thinkingBudget: 2048 }),
        ).toEqual({
            enableThinking: true,
            effort: undefined,
            thinkingBudget: 2048,
        })
        const other = ApiProfile.create({ provider: "openai", openai: {} })
        expect(resolveProfileReasoningConfig(other, capabilities)).toBeUndefined()
    })
})
