import { describe, expect, it } from "vitest"
import { effectiveAggressiveRendering, normalizeAggressiveRenderingLevel } from "../AggressiveRendering"

describe("effectiveAggressiveRendering", () => {
    it.each([
        { featureFlag: false, user: "standard", expected: "standard" },
        { featureFlag: false, user: "activity", expected: "standard" },
        { featureFlag: false, user: "turn", expected: "standard" },
        { featureFlag: true, user: "standard", expected: "standard" },
        { featureFlag: true, user: "activity", expected: "activity" },
        { featureFlag: true, user: "turn", expected: "turn" },
        { featureFlag: true, user: "round", expected: "standard" },
        { featureFlag: true, user: undefined, expected: "standard" },
    ] as const)("flag $featureFlag with user $user renders at $expected", ({ featureFlag, user, expected }) => {
        expect(effectiveAggressiveRendering({ featureFlag, user: user as never })).toBe(expected)
    })

    it("renders at standard when the extension has not projected the setting", () => {
        expect(effectiveAggressiveRendering(undefined)).toBe("standard")
    })

    it("keeps the stored choice when the flag turns off and on again", () => {
        const stored = { user: "turn", featureFlag: true } as const

        expect(effectiveAggressiveRendering({ ...stored, featureFlag: false })).toBe("standard")
        expect(effectiveAggressiveRendering(stored)).toBe("turn")
    })
})

describe("normalizeAggressiveRenderingLevel", () => {
    it("reads an unknown stored value as standard", () => {
        expect(normalizeAggressiveRenderingLevel("round")).toBe("standard")
        expect(normalizeAggressiveRenderingLevel(3)).toBe("standard")
        expect(normalizeAggressiveRenderingLevel("activity")).toBe("activity")
    })
})
