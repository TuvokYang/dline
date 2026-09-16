import { describe, expect, it } from "vitest"
import { expectedRowHeight, heightToHold, isGestureActive } from "./mountBarrier"
import { SCROLL_SETTLE_MS } from "./windowGrowthTiming"

describe("isGestureActive", () => {
	it("treats a pause shorter than the settle window as the same gesture", () => {
		// The pauses inside one gesture are what the library's own flag gets
		// wrong: a wheel notch every 45ms repeatedly looks like a stop.
		expect(isGestureActive(45)).toBe(true)
		expect(isGestureActive(SCROLL_SETTLE_MS - 1)).toBe(true)
	})

	it("treats the settle window itself as over", () => {
		expect(isGestureActive(SCROLL_SETTLE_MS)).toBe(false)
		expect(isGestureActive(SCROLL_SETTLE_MS + 1)).toBe(false)
	})

	it("reports no gesture before the reader has scrolled at all", () => {
		expect(isGestureActive(null)).toBe(false)
	})
})

describe("expectedRowHeight", () => {
	it("reads the size the list wrote onto the row", () => {
		expect(expectedRowHeight("431")).toBe(431)
		expect(expectedRowHeight(66)).toBe(66)
	})

	it("refuses values that cannot describe a height", () => {
		// A zero or negative cap would collapse the row, and a missing
		// attribute means the list has not placed the row yet.
		expect(expectedRowHeight("0")).toBeUndefined()
		expect(expectedRowHeight(-1)).toBeUndefined()
		expect(expectedRowHeight(undefined)).toBeUndefined()
		expect(expectedRowHeight(null)).toBeUndefined()
		expect(expectedRowHeight("auto")).toBeUndefined()
	})
})

describe("heightToHold", () => {
	it("holds an unmeasured row at the height the list expects", () => {
		// The case that produced the defect: the padding above released 66px
		// while the row itself wanted 431px.
		expect(heightToHold("66", true, false)).toBe(66)
	})

	it("leaves rows alone once the reader stops", () => {
		// Correcting after the gesture is what makes the correction invisible;
		// holding a row past that point would keep content hidden.
		expect(heightToHold("66", false, false)).toBeUndefined()
	})

	it("leaves a row alone once it has been measured", () => {
		// Its size is truthful by then, so a cap would hide content and buy
		// nothing: the padding and the row already agree.
		expect(heightToHold("431", true, true)).toBeUndefined()
	})

	it("leaves a row alone when the list has no size for it", () => {
		expect(heightToHold(undefined, true, false)).toBeUndefined()
	})
})
