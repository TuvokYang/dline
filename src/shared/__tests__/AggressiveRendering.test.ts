import { describe, expect, it } from "vitest"
import {
    effectiveAggressiveRendering,
    isAggressiveRenderingLevel,
    normalizeAggressiveRenderingLevel,
    projectAggressiveRendering,
} from "../AggressiveRendering"

describe("chat folding settings", () => {
    it.each([
        ["none", "none"],
        ["message_segment", "message_segment"],
        ["user_turn", "user_turn"],
        ["standard", "none"],
        ["activity", "message_segment"],
        ["turn", "user_turn"],
    ] as const)("reads %s as %s without mutating storage", (stored, expected) => {
        expect(normalizeAggressiveRenderingLevel(stored)).toBe(expected)
        expect(projectAggressiveRendering(stored, true)).toEqual({ user: expected, featureFlag: true })
        expect(effectiveAggressiveRendering({ user: expected, featureFlag: false })).toBe("none")
        expect(effectiveAggressiveRendering({ user: expected, featureFlag: true })).toBe(expected)
    })

    it.each([undefined, null, "unknown", 3, {}])("falls back safely for %s", (stored) => {
        expect(normalizeAggressiveRenderingLevel(stored)).toBe("none")
        expect(isAggressiveRenderingLevel(stored)).toBe(false)
    })

    it("uses only canonical values for new writes", () => {
        expect(["none", "message_segment", "user_turn"].map(isAggressiveRenderingLevel)).toEqual([true, true, true])
        expect(["standard", "activity", "turn"].map(isAggressiveRenderingLevel)).toEqual([false, false, false])
        expect(effectiveAggressiveRendering(undefined)).toBe("none")
    })
})
