import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SCROLL_SETTLE_MS } from "../utils/windowGrowthTiming"
import { useMountBarrier } from "./useMountBarrier"

/** A scroller that reports a settled layout unless a test says otherwise. */
function makeScroller(): HTMLElement {
	const element = document.createElement("div")
	document.body.appendChild(element)
	return element
}

describe("useMountBarrier", () => {
	let scroller: HTMLElement

	beforeEach(() => {
		vi.useFakeTimers()
		scroller = makeScroller()
	})

	afterEach(() => {
		vi.useRealTimers()
		scroller.remove()
	})

	it("raises the barrier as soon as the reader scrolls", () => {
		const { result } = renderHook(() => useMountBarrier(scroller, () => null))
		expect(result.current.held).toBe(false)

		act(() => {
			scroller.dispatchEvent(new Event("wheel"))
		})

		expect(result.current.held).toBe(true)
	})

	it("stays up across the pauses inside one gesture", () => {
		// The defect this replaces: the library's flag went false about 100ms
		// after the last event, so a wheel turned every 45ms released the
		// barrier mid-gesture and the jolt reappeared at a different moment.
		const { result } = renderHook(() => useMountBarrier(scroller, () => null))

		act(() => {
			scroller.dispatchEvent(new Event("wheel"))
		})
		for (let notch = 0; notch < 6; notch++) {
			act(() => {
				vi.advanceTimersByTime(45)
				scroller.dispatchEvent(new Event("wheel"))
			})
			expect(result.current.held).toBe(true)
		}
	})

	it("lowers the barrier once the gesture settles", () => {
		const { result } = renderHook(() => useMountBarrier(scroller, () => null))

		act(() => {
			scroller.dispatchEvent(new Event("wheel"))
		})
		act(() => {
			vi.advanceTimersByTime(SCROLL_SETTLE_MS + 1)
		})

		expect(result.current.held).toBe(false)
	})

	it("pays back the space the released rows take", () => {
		// Releasing lets held rows grow to their real height, which pushes the
		// anchor down. The correction runs in the same layout pass, so the row
		// never moves on screen.
		let anchor = 100
		scroller.scrollTop = 500
		const { result } = renderHook(() =>
			useMountBarrier(scroller, () => {
				const current = anchor
				// The second reading of a release sees the grown rows.
				anchor = 140
				return current
			}),
		)

		act(() => {
			scroller.dispatchEvent(new Event("wheel"))
		})
		expect(result.current.held).toBe(true)

		act(() => {
			vi.advanceTimersByTime(SCROLL_SETTLE_MS + 1)
		})

		expect(scroller.scrollTop).toBe(540)
	})

	it("does not correct when the anchor did not move", () => {
		scroller.scrollTop = 500
		const { result } = renderHook(() => useMountBarrier(scroller, () => 100))

		act(() => {
			scroller.dispatchEvent(new Event("wheel"))
		})
		act(() => {
			vi.advanceTimersByTime(SCROLL_SETTLE_MS + 1)
		})

		expect(result.current.held).toBe(false)
		expect(scroller.scrollTop).toBe(500)
	})

	it("drops the barrier immediately when asked", () => {
		// Jumping owns its destination, so the barrier must not also correct.
		const { result } = renderHook(() => useMountBarrier(scroller, () => null))

		act(() => {
			scroller.dispatchEvent(new Event("wheel"))
		})
		act(() => {
			result.current.release()
		})

		expect(result.current.held).toBe(false)
	})

	it("pays nothing back when the barrier is dropped for navigation", () => {
		// The jump owns its destination. A correction measured against the row
		// that happened to be on screen beforehand would move it away again.
		let anchor = 100
		scroller.scrollTop = 500
		const { result } = renderHook(() =>
			useMountBarrier(scroller, () => {
				const current = anchor
				anchor = 140
				return current
			}),
		)

		act(() => {
			scroller.dispatchEvent(new Event("wheel"))
		})
		act(() => {
			result.current.release()
		})

		expect(scroller.scrollTop).toBe(500)
	})

	it("remembers which rows the list has measured", () => {
		const { result } = renderHook(() => useMountBarrier(scroller, () => null))

		expect(result.current.hasMeasured("7")).toBe(false)
		act(() => {
			result.current.markMeasured("7")
		})
		expect(result.current.hasMeasured("7")).toBe(true)
		expect(result.current.hasMeasured("8")).toBe(false)
	})
})
