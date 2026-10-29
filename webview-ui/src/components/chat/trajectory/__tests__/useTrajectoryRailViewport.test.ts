import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RAIL_SCROLL_IDLE_MS, useTrajectoryRailViewport } from "../useTrajectoryRailViewport"

describe("useTrajectoryRailViewport", () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    it("shows the rail while the list scrolls and hides it once scrolling has been idle", () => {
        const scroller = document.createElement("div")
        const { result } = renderHook(() => useTrajectoryRailViewport(scroller))
        expect(result.current.scrolling).toBe(false)

        act(() => {
            scroller.dispatchEvent(new Event("scroll"))
        })
        expect(result.current.scrolling).toBe(true)

        // Every scroll event of a gesture restarts the idle wait.
        act(() => {
            vi.advanceTimersByTime(RAIL_SCROLL_IDLE_MS - 1)
            scroller.dispatchEvent(new Event("scroll"))
            vi.advanceTimersByTime(RAIL_SCROLL_IDLE_MS - 1)
        })
        expect(result.current.scrolling).toBe(true)

        act(() => {
            vi.advanceTimersByTime(1)
        })
        expect(result.current.scrolling).toBe(false)
    })

    it("stops listening when the list goes away", () => {
        const scroller = document.createElement("div")
        const { result, rerender } = renderHook(({ element }) => useTrajectoryRailViewport(element), {
            initialProps: { element: scroller as HTMLElement | null },
        })

        rerender({ element: null })
        act(() => {
            scroller.dispatchEvent(new Event("scroll"))
        })

        expect(result.current.scrolling).toBe(false)
    })
})
