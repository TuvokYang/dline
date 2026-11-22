import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ScrollReveal } from "./ScrollReveal"

function fixture(scroller: HTMLElement, scope = "opening-1") {
    return (
        <div data-testid="messages">
            <ScrollReveal scope={scope} scroller={scroller}>
                <button type="button">Fold</button>
                <button type="button">Jump</button>
            </ScrollReveal>
        </div>
    )
}

const overlay = () => screen.getByRole("button", { name: "Fold" }).parentElement!
const advance = (ms: number) => act(() => vi.advanceTimersByTime(ms))
const isActive = () => overlay().getAttribute("data-floating-active") === "true"

describe("ScrollReveal", () => {
    beforeEach(() => vi.useFakeTimers())
    afterEach(() => {
        cleanup()
        vi.useRealTimers()
    })

    it("ignores message hover and wheel intent, and holds for one second after the last actual scroll", () => {
        const scroller = document.createElement("div")
        render(fixture(scroller))
        fireEvent.pointerEnter(screen.getByTestId("messages"))
        fireEvent.wheel(scroller, { deltaY: 100 })
        expect(isActive()).toBe(false)

        fireEvent.scroll(scroller)
        expect(isActive()).toBe(true)
        advance(999)
        expect(isActive()).toBe(true)
        fireEvent.scroll(scroller)
        advance(999)
        expect(isActive()).toBe(true)
        advance(1)
        expect(isActive()).toBe(false)
    })

    it("does not reveal for scroll events from nested content", () => {
        const scroller = document.createElement("div")
        const nested = document.createElement("div")
        scroller.append(nested)
        render(fixture(scroller))
        fireEvent.scroll(nested)
        expect(isActive()).toBe(false)
        fireEvent.scroll(scroller)
        expect(isActive()).toBe(true)
    })

    it("keeps an engaged control usable and starts the same hold when the pointer leaves", () => {
        const scroller = document.createElement("div")
        render(fixture(scroller))
        fireEvent.scroll(scroller)
        advance(800)
        fireEvent.pointerEnter(overlay())
        advance(2_000)
        expect(isActive()).toBe(true)
        fireEvent.pointerLeave(overlay())
        advance(999)
        expect(isActive()).toBe(true)
        advance(1)
        expect(isActive()).toBe(false)
    })

    it("starts the hold only when keyboard focus leaves the group, not between its controls", () => {
        const scroller = document.createElement("div")
        render(fixture(scroller))
        const fold = screen.getByRole("button", { name: "Fold" })
        const jump = screen.getByRole("button", { name: "Jump" })
        fireEvent.blur(fold, { relatedTarget: jump })
        expect(isActive()).toBe(false)
        fireEvent.blur(jump, { relatedTarget: document.body })
        expect(isActive()).toBe(true)
        advance(1_000)
        expect(isActive()).toBe(false)
    })

    it("cleans up timers and the previous scroller when the list or opening changes", () => {
        const first = document.createElement("div")
        const second = document.createElement("div")
        const view = render(fixture(first))
        fireEvent.scroll(first)
        view.rerender(fixture(second))
        expect(isActive()).toBe(false)
        fireEvent.scroll(first)
        expect(isActive()).toBe(false)
        fireEvent.scroll(second)
        expect(isActive()).toBe(true)
        view.rerender(fixture(second, "opening-2"))
        expect(isActive()).toBe(false)
        fireEvent.scroll(second)
        expect(isActive()).toBe(true)
        view.unmount()
        expect(vi.getTimerCount()).toBe(0)
        fireEvent.scroll(second)
        expect(vi.getTimerCount()).toBe(0)
    })

    it("does not rerender its children on scroll or expiry", () => {
        const scroller = document.createElement("div")
        const renderChild = vi.fn()
        function Child() {
            renderChild()
            return <span>Content</span>
        }
        render(
            <ScrollReveal scroller={scroller}>
                <Child />
            </ScrollReveal>,
        )
        fireEvent.scroll(scroller)
        advance(1_000)
        expect(renderChild).toHaveBeenCalledTimes(1)
    })
})
