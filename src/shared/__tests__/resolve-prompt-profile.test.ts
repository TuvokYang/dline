import { PromptProfile } from "@core/prompts/profiles/types"
import { describe, expect, it } from "vitest"
import { resolvePromptProfile } from "../resolve-prompt-profile"

describe("resolvePromptProfile", () => {
    it.each([
        [PromptProfile.Standard, 8_000, PromptProfile.Standard],
        [PromptProfile.Lite, 1_000_000, PromptProfile.Lite],
    ] as const)("prefers explicit %s over context window %s", (explicitProfile, contextWindow, expected) => {
        expect(resolvePromptProfile({ explicitProfile, contextWindow })).toBe(expected)
    })

    it.each([
        [63_999, PromptProfile.Lite],
        [64_000, PromptProfile.Standard],
        [128_000, PromptProfile.Standard],
    ] as const)("resolves context window %s to %s", (contextWindow, expected) => {
        expect(resolvePromptProfile({ contextWindow })).toBe(expected)
    })

    it.each(["o1", "o1-preview", "openai/o1-mini"])("uses the Lite profile for %s", (modelId) => {
        expect(resolvePromptProfile({ modelId, contextWindow: 128_000 })).toBe(PromptProfile.Lite)
    })

    it.each([
        undefined,
        0,
        -1,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
    ])("treats invalid context window %s as the 128K Standard default", (contextWindow) => {
        expect(resolvePromptProfile({ contextWindow })).toBe(PromptProfile.Standard)
    })

    it("rejects an invalid explicit runtime profile instead of silently defaulting", () => {
        expect(() =>
            resolvePromptProfile({
                explicitProfile: "invalid" as PromptProfile,
                contextWindow: 32_000,
            }),
        ).toThrowError("Invalid explicit PromptProfile")
    })
})
