import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createScrollArbiter } from "./scrollArbiter"

describe("createScrollArbiter", () => {
    let animationFrames: Map<number, FrameRequestCallback>
    let nextFrameId: number

    const flushAnimationFrames = () => {
        const pending = [...animationFrames.values()]
        animationFrames.clear()
        for (const callback of pending) callback(0)
    }

    beforeEach(() => {
        vi.useFakeTimers()
        animationFrames = new Map()
        nextFrameId = 1
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
            const id = nextFrameId++
            animationFrames.set(id, callback)
            return id
        })
        vi.stubGlobal("cancelAnimationFrame", (id: number) => {
            animationFrames.delete(id)
        })
    })

    afterEach(() => {
        vi.useRealTimers()
        vi.unstubAllGlobals()
    })

    it("keeps a layout-settle chain when a passive update arrives", () => {
        const arbiter = createScrollArbiter()
        const layoutScroll = vi.fn()
        const passiveScroll = vi.fn()

        arbiter.request({
            run: layoutScroll,
            priority: "layout",
            retryDelaysMs: [50, 200],
        })
        arbiter.request({ run: passiveScroll, priority: "passive" })

        flushAnimationFrames()
        expect(layoutScroll).toHaveBeenCalledTimes(1)
        expect(passiveScroll).not.toHaveBeenCalled()

        vi.advanceTimersByTime(200)
        expect(layoutScroll).toHaveBeenCalledTimes(3)

        arbiter.request({ run: passiveScroll, priority: "passive" })
        flushAnimationFrames()
        expect(passiveScroll).toHaveBeenCalledTimes(1)
    })

    it("lets a user request replace a pending layout chain", () => {
        const arbiter = createScrollArbiter()
        const layoutScroll = vi.fn()
        const userScroll = vi.fn()

        arbiter.request({
            run: layoutScroll,
            priority: "layout",
            retryDelaysMs: [50, 200],
        })
        arbiter.request({ run: userScroll, priority: "user" })

        flushAnimationFrames()
        vi.advanceTimersByTime(200)

        expect(layoutScroll).not.toHaveBeenCalled()
        expect(userScroll).toHaveBeenCalledTimes(1)
    })

    it("cancels every remaining attempt", () => {
        const arbiter = createScrollArbiter()
        const run = vi.fn()

        arbiter.request({ run, priority: "layout", retryDelaysMs: [50, 200] })
        arbiter.cancel()
        flushAnimationFrames()
        vi.advanceTimersByTime(200)

        expect(run).not.toHaveBeenCalled()
    })
})
