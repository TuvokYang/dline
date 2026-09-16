import { describe, expect, it } from "vitest"
import { decideWindowGrowth, SCROLL_SETTLE_MS, URGENT_MESSAGE_DISTANCE, type WindowGrowthSignals } from "./windowGrowthTiming"

/** Plenty of room on both sides, so only the scroll timing decides. */
function signals(overrides: Partial<WindowGrowthSignals> = {}): WindowGrowthSignals {
	return {
		msSinceLastScroll: null,
		messagesToLeadingEdge: 200,
		messagesToTrailingEdge: 200,
		...overrides,
	}
}

describe("decideWindowGrowth", () => {
	it("loads immediately when the reader has not scrolled", () => {
		// The opening render has no scroll to disturb.
		expect(decideWindowGrowth(signals())).toBe("run")
	})

	it("holds the window still while a scroll is in progress", () => {
		// This is the case the deferral exists for: growing here changes the
		// content above the viewport in the middle of a scroll.
		expect(decideWindowGrowth(signals({ msSinceLastScroll: 0 }))).toBe("defer")
		expect(decideWindowGrowth(signals({ msSinceLastScroll: SCROLL_SETTLE_MS - 1 }))).toBe("defer")
	})

	it("loads once the scroll has settled", () => {
		expect(decideWindowGrowth(signals({ msSinceLastScroll: SCROLL_SETTLE_MS }))).toBe("run")
		expect(decideWindowGrowth(signals({ msSinceLastScroll: 5_000 }))).toBe("run")
	})

	it("loads mid-scroll rather than let the reader reach the loaded edge", () => {
		// Deferring here would show the end of the window instead of the
		// conversation, which is worse than the movement being avoided.
		expect(decideWindowGrowth(signals({ msSinceLastScroll: 0, messagesToLeadingEdge: URGENT_MESSAGE_DISTANCE }))).toBe("run")
		expect(decideWindowGrowth(signals({ msSinceLastScroll: 0, messagesToTrailingEdge: URGENT_MESSAGE_DISTANCE }))).toBe("run")
	})

	it("treats an already exhausted side as urgent", () => {
		expect(decideWindowGrowth(signals({ msSinceLastScroll: 0, messagesToLeadingEdge: 0 }))).toBe("run")
	})

	it("still defers when both edges are comfortably far away", () => {
		expect(
			decideWindowGrowth(
				signals({
					msSinceLastScroll: 0,
					messagesToLeadingEdge: URGENT_MESSAGE_DISTANCE + 1,
					messagesToTrailingEdge: URGENT_MESSAGE_DISTANCE + 1,
				}),
			),
		).toBe("defer")
	})
})
