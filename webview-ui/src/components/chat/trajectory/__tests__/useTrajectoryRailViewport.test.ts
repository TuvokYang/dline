import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { RAIL_SCROLL_IDLE_MS, useTrajectoryRailViewport } from "../useTrajectoryRailViewport"

describe("useTrajectoryRailViewport", () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
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

    it("reads source metadata at most once per frame using real row geometry and the eight-pixel threshold", () => {
        const frames = new Map<number, FrameRequestCallback>()
        let frameId = 0
        const requestFrame = vi.fn((callback: FrameRequestCallback) => {
            frames.set(++frameId, callback)
            return frameId
        })
        vi.stubGlobal("requestAnimationFrame", requestFrame)
        vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id))
        const flush = () =>
            act(() => {
                const callbacks = [...frames.values()]
                frames.clear()
                for (const callback of callbacks) callback(16)
            })
        const scroller = document.createElement("div")
        scroller.getBoundingClientRect = () => ({ top: 100, bottom: 500 }) as DOMRect
        let firstBottom = 140
        for (const [index, sourceIndex] of [0, 67].entries()) {
            const row = document.createElement("div")
            row.dataset.itemIndex = String(1000 + index)
            row.getBoundingClientRect = () =>
                ({
                    top: index === 0 ? 80 : firstBottom,
                    bottom: index === 0 ? firstBottom : 300,
                    height: index === 0 ? firstBottom - 80 : 300 - firstBottom,
                }) as DOMRect
            const content = document.createElement("div")
            content.dataset.rowTs = index === 0 ? "NaN" : "-5"
            content.dataset.rowSourceIndex = String(sourceIndex)
            row.appendChild(content)
            scroller.appendChild(row)
        }
        const { result } = renderHook(() => useTrajectoryRailViewport(scroller))
        flush()
        expect(result.current.topVisibleIndex).toBe(0)
        firstBottom = 104
        act(() => {
            for (let event = 0; event < 3; event++) scroller.dispatchEvent(new Event("scroll"))
        })
        expect(frames.size).toBe(1)
        expect(result.current.topVisibleIndex).toBe(0)
        flush()
        expect(result.current.topVisibleIndex).toBe(67)
        expect(result.current.scrolling).toBe(true)
        expect(requestFrame).toHaveBeenCalledTimes(2)
        act(() => vi.advanceTimersByTime(1_200))
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
