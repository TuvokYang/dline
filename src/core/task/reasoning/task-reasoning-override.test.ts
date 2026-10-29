import type { ThinkingConfig } from "@shared/proto/dline/models/metadata"
import type { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it } from "vitest"
import {
    applyTaskReasoningOverride,
    normalizeTaskReasoningOverride,
    validateTaskReasoningOverride,
} from "./task-reasoning-override"

function createProfile(): ApiProfile {
    return {
        id: "profile-1",
        name: "OpenAI profile",
        provider: "openai",
        apiKey: "secret",
        modelId: "reasoning-model",
        usedFor: [],
        legacyNames: [],
        enabled: true,
        openai: {
            reasoning: {
                enableThinking: true,
                effort: "medium",
                thinkingBudget: 4096,
            },
            customModelEnabled: false,
            capabilities: undefined,
            pricing: undefined,
            azureIdentity: false,
            openAiHeaders: {},
            streamIncludeUsage: false,
            promptCacheMode: 0,
        } as ApiProfile["openai"],
    }
}

const effortCapability: ThinkingConfig = {
    supported: true,
    mode: "effort",
    effortLevels: ["low", "medium", "high"],
}

const budgetCapability: ThinkingConfig = {
    supported: true,
    mode: "budget",
    maxBudget: 8192,
}

const bothCapability: ThinkingConfig = {
    supported: true,
    mode: "effort",
    effortLevels: ["none", "low", "medium", "high"],
    maxBudget: 8192,
}

describe("Task reasoning override domain", () => {
    it("normalizes inherit without retaining stale mode-specific values", () => {
        expect(normalizeTaskReasoningOverride({ kind: "inherit", effort: "high", budgetTokens: 2048 })).toEqual({
            kind: "inherit",
        })
    })

    it("accepts an effort override only when the selected effort is supported", () => {
        expect(validateTaskReasoningOverride({ kind: "effort", effort: "high" }, effortCapability)).toEqual({
            valid: true,
            override: { kind: "effort", effort: "high" },
        })
    })

    it("allows explicit none only when the provider advertises none", () => {
        expect(validateTaskReasoningOverride({ kind: "effort", effort: "none" }, effortCapability)).toMatchObject({
            valid: false,
            error: "unsupported_effort",
        })
        expect(validateTaskReasoningOverride({ kind: "effort", effort: "none" }, bothCapability)).toEqual({
            valid: true,
            override: { kind: "effort", effort: "none" },
        })
    })

    it("accepts a budget override when it is a safe integer within the model limit", () => {
        expect(validateTaskReasoningOverride({ kind: "budget", budgetTokens: 4096 }, budgetCapability)).toEqual({
            valid: true,
            override: { kind: "budget", budgetTokens: 4096 },
        })
    })

    it.each([
        [-1, "negative_budget"],
        [8193, "budget_exceeds_max"],
        [1.5, "invalid_budget"],
        [Number.MAX_SAFE_INTEGER + 1, "invalid_budget"],
    ] as const)("rejects invalid budget %s", (budgetTokens, error) => {
        expect(validateTaskReasoningOverride({ kind: "budget", budgetTokens }, budgetCapability)).toMatchObject({
            valid: false,
            error,
        })
    })

    it("rejects an override when the model does not expose the requested capability", () => {
        expect(validateTaskReasoningOverride({ kind: "effort", effort: "high" }, budgetCapability)).toMatchObject({
            valid: false,
            error: "unsupported_effort",
        })
        expect(validateTaskReasoningOverride({ kind: "budget", budgetTokens: 1024 }, effortCapability)).toMatchObject({
            valid: false,
            error: "unsupported_budget",
        })
    })

    it("applies effort without mutating the Catalog Profile or retaining a budget", () => {
        const profile = createProfile()
        const runtimeProfile = applyTaskReasoningOverride(profile, { kind: "effort", effort: "high" })

        expect(runtimeProfile).not.toBe(profile)
        expect(runtimeProfile.openai).not.toBe(profile.openai)
        expect(runtimeProfile.openai?.reasoning).toEqual({
            enableThinking: true,
            effort: "high",
            thinkingBudget: undefined,
        })
        expect(profile.openai?.reasoning).toEqual({
            enableThinking: true,
            effort: "medium",
            thinkingBudget: 4096,
        })
    })

    it("applies budget without mutating the Catalog Profile or retaining effort", () => {
        const profile = createProfile()
        const runtimeProfile = applyTaskReasoningOverride(profile, { kind: "budget", budgetTokens: 2048 })

        expect(runtimeProfile.openai?.reasoning).toEqual({
            enableThinking: true,
            effort: undefined,
            thinkingBudget: 2048,
        })
        expect(profile.openai?.reasoning?.effort).toBe("medium")
        expect(profile.openai?.reasoning?.thinkingBudget).toBe(4096)
    })

    it("restores the Profile reasoning configuration for inherit", () => {
        const profile = createProfile()
        const runtimeProfile = applyTaskReasoningOverride(profile, { kind: "inherit" })

        expect(runtimeProfile).not.toBe(profile)
        expect(runtimeProfile.openai?.reasoning).toEqual(profile.openai?.reasoning)
        expect(profile.openai?.reasoning?.effort).toBe("medium")
    })
})
