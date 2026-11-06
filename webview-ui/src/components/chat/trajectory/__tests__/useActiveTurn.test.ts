import { describe, expect, it } from "vitest"
import { activeTurnSeq } from "../useActiveTurn"

describe("activeTurnSeq", () => {
    // Deliberately unrelated source positions, seq identities and timestamp order.
    const turns = [
        { seq: 0, anchorIndex: 0, anchorTs: 400 },
        { seq: 1, anchorIndex: 19, anchorTs: 400 },
        { seq: 2, anchorIndex: 42, anchorTs: 10 },
    ]

    it("selects the containing committed user interval, not a timestamp or page/render offset", () => {
        expect(activeTurnSeq(turns, 0)).toBe(0)
        expect(activeTurnSeq(turns, 18)).toBe(0)
        expect(activeTurnSeq(turns, 19)).toBe(1)
        expect(activeTurnSeq(turns, 41)).toBe(1)
        expect(activeTurnSeq(turns, 42)).toBe(2)
        expect(activeTurnSeq(turns, 900)).toBe(2)
    })

    it("keeps points without an index but uses only located intervals", () => {
        const withMissing = [turns[0], { seq: 5 }, { seq: 7, anchorIndex: 30 }]
        expect(activeTurnSeq(withMissing, 20)).toBe(0)
        expect(activeTurnSeq(withMissing, 30)).toBe(7)
        expect(withMissing).toHaveLength(3)
        expect(activeTurnSeq([{ seq: 1, anchorIndex: 19 }], 2)).toBe(1)
    })

    it("marks nothing without located turns or a visible source index", () => {
        expect(activeTurnSeq([], 40)).toBeUndefined()
        expect(activeTurnSeq([{ seq: 2 }], 40)).toBeUndefined()
        expect(activeTurnSeq(turns, undefined)).toBeUndefined()
    })
})
