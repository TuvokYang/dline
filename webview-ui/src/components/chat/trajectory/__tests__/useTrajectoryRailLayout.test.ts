import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useCompressedBarGap, useFollowActiveTurn, useScrollEdges } from "../useTrajectoryRailLayout"

/** Layout values jsdom does not compute, set the way a browser would report them. */
function setMetrics(element: HTMLElement, metrics: Record<string, number>): void {
    for (const [name, value] of Object.entries(metrics)) {
        Object.defineProperty(element, name, { configurable: true, writable: true, value })
    }
}

class FakeResizeObserver {
    static instances: FakeResizeObserver[] = []
    observed: Element[] = []

    constructor(private readonly callback: ResizeObserverCallback) {
        FakeResizeObserver.instances.push(this)
    }

    observe(target: Element): void {
        this.observed.push(target)
    }

    unobserve(): void {}

    disconnect(): void {
        this.observed = []
    }

    /** Report a size change of every observed element, as the browser does after layout. */
    resize(): void {
        if (this.observed.length > 0) this.callback([], this as unknown as ResizeObserver)
    }
}

describe("rail layout hooks on elements that mount after the first render", () => {
    beforeEach(() => {
        FakeResizeObserver.instances = []
        vi.stubGlobal("ResizeObserver", FakeResizeObserver)
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("follows scrolling of a rail scroller that appears once turns arrive", () => {
        const { result, rerender } = renderHook(({ scroller }) => useScrollEdges(scroller), {
            initialProps: { scroller: null as HTMLElement | null },
        })
        expect(result.current).toEqual({ top: false, bottom: false })

        const scroller = document.createElement("div")
        setMetrics(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 300 })
        rerender({ scroller })
        expect(result.current).toEqual({ top: false, bottom: true })

        // No render happens here: only the scroll listener can notice the new position.
        act(() => {
            setMetrics(scroller, { scrollTop: 200 })
            scroller.dispatchEvent(new Event("scroll"))
        })
        expect(result.current).toEqual({ top: true, bottom: false })
    })

    it("tightens the bars when the chat it overlays is resized after the rail mounted", () => {
        const container = document.createElement("div")
        const rail = document.createElement("nav")
        const scroller = document.createElement("div")
        container.appendChild(rail)
        rail.appendChild(scroller)
        setMetrics(container, { clientHeight: 0 })
        setMetrics(rail, { offsetHeight: 200 })
        setMetrics(scroller, { scrollHeight: 190, clientHeight: 190 })

        const { result, rerender } = renderHook(
            ({ railElement, scrollerElement }) => useCompressedBarGap(railElement, scrollerElement, 4),
            {
                initialProps: { railElement: null as HTMLElement | null, scrollerElement: null as HTMLElement | null },
            },
        )
        rerender({ railElement: rail, scrollerElement: scroller })
        // Not laid out yet: the widest spacing stays.
        expect(result.current).toBe(6)

        act(() => {
            setMetrics(container, { clientHeight: 100 })
            for (const observer of FakeResizeObserver.instances) observer.resize()
        })

        // 80% of 100px leaves 120px too little for a 200px rail, so the gap drops to its floor.
        expect(result.current).toBe(2)
    })

    it("follows the exact seq, including zero, when two bars share a timestamp", () => {
        const scroller = document.createElement("div")
        setMetrics(scroller, { clientHeight: 100, scrollHeight: 500 })
        scroller.getBoundingClientRect = () => ({ top: 100, height: 100 }) as DOMRect
        const scrollBy = vi.fn()
        scroller.scrollBy = scrollBy
        const locations = [
            [0, 300],
            [1, 360],
        ]
        for (const [seq, top] of locations) {
            const bar = document.createElement("button")
            bar.dataset.turnSeq = String(seq)
            bar.dataset.turnTs = "500"
            bar.getBoundingClientRect = () => ({ top, height: 8 }) as DOMRect
            scroller.appendChild(bar)
        }
        const { rerender } = renderHook(({ seq, paused }) => useFollowActiveTurn(scroller, seq, paused), {
            initialProps: { seq: 1, paused: false },
        })
        expect(scrollBy).toHaveBeenLastCalledWith({ top: 214, behavior: "smooth" })
        rerender({ seq: 0, paused: false })
        expect(scrollBy).toHaveBeenLastCalledWith({ top: 154, behavior: "smooth" })
        rerender({ seq: 1, paused: true })
        expect(scrollBy).toHaveBeenCalledTimes(2)
    })
})
