import { describe, expect, it } from "vitest"
import {
    measurePaintedDirection,
    measurePaintedDisplacements,
    type PaintedFrame,
} from "./e2e/utils/chat-scroll-jitter/measurements"

function frame(visible: Record<string, number>, scrollTop = 0, programmaticTotal = 0): PaintedFrame {
    return { time: 0, scrollTop, programmaticTotal, visible, afterResize: true, anchorTop: null, trackedTs: null }
}

describe("painted chat displacement calibration", () => {
    it("subtracts wheel travel from each stable message, including rows crossing a clipping edge", () => {
        const result = measurePaintedDisplacements([
            frame({ leaving: -5, held: 25, held2: 50 }),
            frame({ held: 0, held2: 25, entering: 75 }, 25),
        ])
        expect(result.coverageGaps).toBe(0)
        expect(result.shifts.map((shift) => shift.shift)).toEqual([0])
        expect(result.shifts[0]?.sharedRows).toBe(2)
    })

    it("does not treat a compensated prepend as thousands of pixels of reader travel", () => {
        const result = measurePaintedDisplacements([frame({ a: 0, b: 25 }, 1000), frame({ a: 0, b: 25 }, 7500, 6500)])
        expect(result.coverageGaps).toBe(0)
        expect(result.shifts[0]?.readerScroll).toBe(0)
        expect(result.shifts[0]?.shift).toBe(0)
    })

    it.each([120, -120, 300, -300])("detects a real %ipx jump even when another row stays still", (jump) => {
        const result = measurePaintedDisplacements([frame({ a: 0, b: 25 }), frame({ a: 0, b: 25 + jump })])
        expect(result.shifts[0]?.shift).toBe(jump)
        expect(result.shifts.filter((shift) => Math.abs(shift.shift) >= 120)).toHaveLength(1)
        expect(result.shifts.filter((shift) => Math.abs(shift.shift) >= 300)).toHaveLength(Math.abs(jump) >= 300 ? 1 : 0)
    })

    it("exposes a whole viewport replacement instead of passing it as zero displacement", () => {
        const result = measurePaintedDisplacements([frame({ a: 0 }), frame({ b: 0 })])
        expect(result.coverageGaps).toBe(1)
        expect(result.shifts).toHaveLength(0)
    })
})

describe("painted chat direction calibration", () => {
    it.each([1, -1] as const)("detects a single backwards row when reading in direction %i", (direction) => {
        const result = measurePaintedDirection(
            [frame({ still: 50, moves: 100 }, 1000), frame({ still: 50, moves: 100 - direction * 20 }, 1000 - direction * 80)],
            direction,
        )
        expect(result).toEqual({ backwardFrames: 1, comparedFrames: 1, coverageGaps: 0 })
    })

    it("does not lose a real reversal when the chosen anchor changes", () => {
        const before = { ...frame({ a: 50, b: 100 }, 1000), trackedTs: "a", anchorTop: 50 }
        const after = { ...frame({ a: 30, b: 180 }, 920), trackedTs: "b", anchorTop: 180 }
        expect(measurePaintedDirection([before, after], 1).backwardFrames).toBe(1)
    })

    it.each([
        { movement: -5.9, backwardFrames: 0 },
        { movement: -6, backwardFrames: 1 },
    ])("keeps the original six-pixel boundary at $movement", ({ movement, backwardFrames }) => {
        expect(measurePaintedDirection([frame({ a: 50 }, 1000), frame({ a: 50 + movement }, 920)], 1).backwardFrames).toBe(
            backwardFrames,
        )
    })

    it("reports missing shared identities rather than counting them as stable frames", () => {
        expect(measurePaintedDirection([frame({ leaving: 10 }, 1000), frame({ entering: 10 }, 920)], 1)).toEqual({
            backwardFrames: 0,
            comparedFrames: 0,
            coverageGaps: 1,
        })
    })

    it("does not treat movement with the requested direction as a reversal", () => {
        expect(measurePaintedDirection([frame({ a: 10 }, 1000), frame({ a: 90 }, 920)], 1)).toEqual({
            backwardFrames: 0,
            comparedFrames: 1,
            coverageGaps: 0,
        })
    })
})
