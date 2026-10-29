import type { ApiProfile } from "@shared/proto/dline/profile"
import {
    applyTaskServiceTierOverride,
    taskServiceTierOverrideFromFields,
    validateTaskServiceTierOverride,
} from "@shared/task-provider-overrides"
import { describe, expect, it } from "vitest"

function createOpenAiProfile(provider: "openai" | "openai-codex" = "openai"): ApiProfile {
    return {
        id: "profile-1",
        name: "OpenAI profile",
        provider,
        apiKey: "secret",
        modelId: "gpt-5.6-sol",
        usedFor: [],
        legacyNames: [],
        enabled: true,
        ...(provider === "openai"
            ? {
                  openai: {
                      reasoning: undefined,
                      customModelEnabled: false,
                      capabilities: undefined,
                      pricing: undefined,
                      azureIdentity: false,
                      openAiHeaders: {},
                      streamIncludeUsage: false,
                      serviceTier: "default",
                      promptCacheMode: 0,
                  } as ApiProfile["openai"],
              }
            : {
                  openaiCodex: {
                      reasoning: undefined,
                      customModelEnabled: false,
                      capabilities: undefined,
                      pricing: undefined,
                      serviceTier: "default",
                  } as ApiProfile["openaiCodex"],
              }),
    }
}

describe("Task service tier override domain", () => {
    it("accepts inherit and every supported OpenAI service tier", () => {
        expect(validateTaskServiceTierOverride({ kind: "inherit" }, "openai")).toEqual({
            valid: true,
            override: { kind: "inherit" },
        })
        for (const tier of ["auto", "default", "flex", "scale", "priority", "ultrafast"] as const) {
            expect(validateTaskServiceTierOverride({ kind: "tier", tier }, "openai-codex")).toEqual({
                valid: true,
                override: { kind: "tier", tier },
            })
        }
    })

    it("rejects unsupported providers and invalid raw tier values", () => {
        expect(validateTaskServiceTierOverride({ kind: "tier", tier: "priority" }, "anthropic")).toMatchObject({
            valid: false,
            error: "unsupported_provider",
        })
        expect(taskServiceTierOverrideFromFields({ kind: "tier", tier: "turbo" })).toBeUndefined()
    })

    it("overlays OpenAI service tier without mutating the Catalog Profile", () => {
        const profile = createOpenAiProfile()
        const runtimeProfile = applyTaskServiceTierOverride(profile, { kind: "tier", tier: "priority" })

        expect(runtimeProfile).not.toBe(profile)
        expect(runtimeProfile.openai).not.toBe(profile.openai)
        expect(runtimeProfile.openai?.serviceTier).toBe("priority")
        expect(profile.openai?.serviceTier).toBe("default")
    })

    it("overlays OpenAI Codex service tier without mutating the Catalog Profile", () => {
        const profile = createOpenAiProfile("openai-codex")
        const runtimeProfile = applyTaskServiceTierOverride(profile, { kind: "tier", tier: "scale" })

        expect(runtimeProfile.openaiCodex?.serviceTier).toBe("scale")
        expect(profile.openaiCodex?.serviceTier).toBe("default")
    })

    it("preserves the Profile service tier for inherit", () => {
        const profile = createOpenAiProfile()
        const runtimeProfile = applyTaskServiceTierOverride(profile, { kind: "inherit" })

        expect(runtimeProfile).not.toBe(profile)
        expect(runtimeProfile.openai?.serviceTier).toBe("default")
        expect(profile.openai?.serviceTier).toBe("default")
    })
})
