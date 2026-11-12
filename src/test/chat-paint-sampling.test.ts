// @vitest-environment jsdom

import type { Frame } from "@playwright/test"
import { afterEach, describe, expect, it, vi } from "vitest"
import { measurePaintedDirection, type PaintedFrame } from "./e2e/utils/chat-scroll-jitter/measurements"
import { startPaintSampling } from "./e2e/utils/chat-scroll-jitter/probes"

vi.mock("./e2e/utils/chat-scroll-jitter/fixture", () => ({ SETTLE_SAMPLE_COUNT: 90, SETTLE_SAMPLE_INTERVAL_MS: 16 }))

function bounds(top: number, height: number): DOMRect {
    return new DOMRect(0, top, 300, height)
}

function element(selector: string): HTMLElement {
    const result = document.querySelector<HTMLElement>(selector)
    if (!result) throw new Error(`Missing fixture element: ${selector}`)
    return result
}

describe("painted chat row sampling", () => {
    afterEach(() => {
        document.body.replaceChildren()
        vi.unstubAllGlobals()
        Reflect.deleteProperty(window, "__dlineScrollEvents")
        Reflect.deleteProperty(window, "__dlinePaintedFrames")
    })

    it.each([
        "tool-group",
        "browser-session",
    ])("tracks a visible %s through its rendered item, not a box-less wrapper", async (kind) => {
        document.body.innerHTML = `
            <div data-virtuoso-scroller="true">
                <div data-testid="virtuoso-item-list">
                    <div data-item-index="100">
                        <div class="contents" data-row-ts="10"><div data-message-ts="10">Regular</div></div>
                    </div>
                    <div data-item-index="101">
                        <div class="contents" data-row-ts="20"><div data-testid="${kind}">Grouped content</div></div>
                    </div>
                </div>
            </div>`
        const scroller = element("[data-virtuoso-scroller]")
        const regular = element('[data-item-index="100"]')
        const group = element('[data-item-index="101"]')
        let shift = 0
        scroller.getBoundingClientRect = () => bounds(100, 120)
        Object.defineProperty(scroller, "clientHeight", { value: 120 })
        scroller.scrollTop = 1_000
        regular.getBoundingClientRect = () => bounds(450 + shift, 40)
        group.getBoundingClientRect = () => bounds(80 + shift, 200)
        element("[data-message-ts]").getBoundingClientRect = regular.getBoundingClientRect
        // `display: contents` has no layout box, so its rect deliberately remains JSDOM's zero rect.
        const callbacks: FrameRequestCallback[] = []
        const draw = (time: number) => {
            const callback = callbacks.shift()
            if (!callback) throw new Error("No rendering callback was scheduled")
            callback(time)
        }
        vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => callbacks.push(callback))
        vi.stubGlobal(
            "ResizeObserver",
            class {
                observe() {}
                disconnect() {}
            },
        )
        Object.defineProperty(window, "__dlineScrollEvents", { value: [], configurable: true })
        const frame = {
            evaluate: async (callback: (value: { duration: number }) => void, value: { duration: number }) => callback(value),
        } as unknown as Frame

        await startPaintSampling(frame, 10_000)
        draw(0)
        shift = 80
        scroller.scrollTop = 920
        draw(16)
        const painted = (window as unknown as { __dlinePaintedFrames: PaintedFrame[] }).__dlinePaintedFrames
        expect(painted[0]?.rows).toEqual([
            { ts: "10", top: 350 },
            { ts: "20", top: -20 },
        ])
        expect(painted[0]?.visible).toEqual({ "20": -20 })
        expect(painted[1]?.visible).toEqual({ "20": 60 })
        expect(measurePaintedDirection(painted, 1)).toEqual({ backwardFrames: 0, comparedFrames: 1, coverageGaps: 0 })

        shift = 60
        scroller.scrollTop = 840
        draw(32)
        expect(measurePaintedDirection(painted, 1)).toEqual({ backwardFrames: 1, comparedFrames: 2, coverageGaps: 0 })
    })
})
