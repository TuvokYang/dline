import { describe, expect, it } from "vitest"
import { activeTurnAnchor } from "../useActiveTurn"

describe("activeTurnAnchor", () => {
    const anchors = [10, 40, 70]

    it("is the last turn opened at or before the top visible message", () => {
        expect(activeTurnAnchor(anchors, 40)).toBe(40)
        expect(activeTurnAnchor(anchors, 55)).toBe(40)
        expect(activeTurnAnchor(anchors, 69)).toBe(40)
    })

    it("stays on the first turn above it and on the last turn below it", () => {
        expect(activeTurnAnchor(anchors, 5)).toBe(10)
        expect(activeTurnAnchor(anchors, 1_000)).toBe(70)
    })

    it("marks nothing without turns or without a visible message", () => {
        expect(activeTurnAnchor([], 40)).toBeUndefined()
        expect(activeTurnAnchor(anchors, undefined)).toBeUndefined()
    })
})
