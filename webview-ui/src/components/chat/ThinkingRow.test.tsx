import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ThinkingRow } from "./ThinkingRow"

const rowProps = { isExpanded: true, isVisible: true, isStreaming: true, showTitle: true }
let height = 600
let viewportHeight = 150
let resizeCallbacks: ResizeObserverCallback[] = []

function viewport(container: HTMLElement): HTMLDivElement {
    const element = container.querySelector<HTMLDivElement>("div.overflow-y-auto")
    if (!element) throw new Error("Thinking scroll viewport is missing")
    return element
}

beforeEach(() => {
    height = 600
    viewportHeight = 150
    resizeCallbacks = []
    const positions = new WeakMap<Element, number>()
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(() => height)
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(() => viewportHeight)
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
        return positions.get(this) ?? 0
    })
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, value: number) {
        positions.set(this, Math.max(0, Math.min(value, height - viewportHeight)))
    })
    vi.stubGlobal(
        "ResizeObserver",
        class {
            constructor(callback: ResizeObserverCallback) {
                resizeCallbacks.push(callback)
            }
            observe() {}
            unobserve() {}
            disconnect() {}
        },
    )
})

afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe("ThinkingRow", () => {
    it("keeps the header as the only collapse button and allows reading the body without toggling", () => {
        const onToggle = vi.fn()
        render(<ThinkingRow {...rowProps} onToggle={onToggle} reasoningContent="**Inspecting** files" />)
        const header = screen.getByRole("button", { name: "Thinking" })
        expect(header).toHaveAttribute("aria-expanded", "true")
        expect(screen.getAllByRole("button")).toHaveLength(1)
        const body = screen.getByRole("region", { name: "Thinking content" })
        fireEvent.click(body)
        expect(onToggle).not.toHaveBeenCalled()
        fireEvent.click(header)
        expect(onToggle).toHaveBeenCalledTimes(1)
    })

    it("renders basic Markdown as semantic content, not literal delimiters", () => {
        const { container } = render(
            <ThinkingRow
                {...rowProps}
                reasoningContent={"**Checking files**\n\n*carefully* with `file.ts`\n\n- first\n- second"}
            />,
        )
        const body = screen.getByRole("region", { name: "Thinking content" })
        expect(body.querySelector("strong")?.textContent).toBe("Checking files")
        expect(body.querySelector("em")?.textContent).toBe("carefully")
        expect(body.querySelector("code")?.textContent).toBe("file.ts")
        expect(
            within(body)
                .getAllByRole("listitem")
                .map((item) => item.textContent),
        ).toEqual(["first", "second"])
        expect(container.querySelector("button code")).toBeNull()
    })

    it("keeps links inert, does not load images or raw HTML, and treats diagram fences as ordinary code", () => {
        render(
            <ThinkingRow
                {...rowProps}
                reasoningContent={[
                    "[file](src/file.ts) and [switch](https://example.com)",
                    "![remote image](https://example.com/image.png)",
                    '<iframe src="https://example.com"></iframe>',
                    "```mermaid\ngraph TD; A-->B;\n```",
                ].join("\n\n")}
            />,
        )
        const body = screen.getByRole("region", { name: "Thinking content" })
        expect(body.querySelectorAll("a, img, iframe, svg, button")).toHaveLength(0)
        expect(body.querySelector("p")?.textContent).toBe("file and switch")
        expect(body.querySelector("pre > code")?.textContent).toBe("graph TD; A-->B;\n")
    })

    it("handles an unfinished Markdown token and its later completion without losing the text", () => {
        const { rerender } = render(<ThinkingRow {...rowProps} reasoningContent="**Check" />)
        expect(screen.getByRole("region").textContent).toBe("**Check")
        rerender(<ThinkingRow {...rowProps} reasoningContent="**Checking**" />)
        const body = screen.getByRole("region")
        expect(body.textContent).toBe("Checking")
        expect(body.querySelector("strong")?.textContent).toBe("Checking")
    })

    it("keeps encrypted reasoning title-only until readable content arrives", () => {
        const { rerender } = render(<ThinkingRow {...rowProps} isExpanded={false} showChevron={false} />)
        expect(screen.getByRole("button", { name: "Thinking" })).not.toHaveAttribute("aria-expanded")
        expect(screen.queryByRole("region")).toBeNull()
        rerender(<ThinkingRow {...rowProps} reasoningContent="Readable now" />)
        expect(screen.getByRole("region").textContent).toBe("Readable now")
    })

    it("follows appended content after it exceeds the viewport", () => {
        const { container, rerender } = render(<ThinkingRow {...rowProps} reasoningContent="First" />)
        const scroll = viewport(container)
        expect(scroll.scrollTop).toBe(450)
        height = 900
        rerender(<ThinkingRow {...rowProps} reasoningContent={"First\n\nLatest line"} />)
        expect(scroll.scrollTop).toBe(750)
    })

    it("starts following when a contentless collapsed streaming row first expands", () => {
        const { container, rerender } = render(<ThinkingRow {...rowProps} isExpanded={false} />)
        rerender(<ThinkingRow {...rowProps} reasoningContent="First visible content" />)
        expect(viewport(container).scrollTop).toBe(450)
    })

    it("does not pull a reader back down until they return to the bottom", () => {
        const { container, rerender } = render(<ThinkingRow {...rowProps} reasoningContent="First" />)
        const scroll = viewport(container)
        scroll.scrollTop = 100
        fireEvent.scroll(scroll)
        height = 900
        rerender(<ThinkingRow {...rowProps} reasoningContent="Second" />)
        expect(scroll.scrollTop).toBe(100)
        scroll.scrollTop = 750
        fireEvent.scroll(scroll)
        height = 1200
        rerender(<ThinkingRow {...rowProps} reasoningContent="Third" />)
        expect(scroll.scrollTop).toBe(1050)
    })

    it("respects even a small upward scroll instead of repeatedly pulling the reader down", () => {
        const { container, rerender } = render(<ThinkingRow {...rowProps} reasoningContent="First" />)
        const scroll = viewport(container)
        scroll.scrollTop -= 1
        fireEvent.scroll(scroll)
        height = 900
        rerender(<ThinkingRow {...rowProps} reasoningContent="Second" />)
        expect(scroll.scrollTop).toBe(449)
    })

    it("does not mistake a scroll event caused by content growth for manual scrolling", () => {
        const { container, rerender } = render(<ThinkingRow {...rowProps} reasoningContent="First" />)
        const scroll = viewport(container)
        fireEvent.scroll(scroll)
        height = 900
        fireEvent.scroll(scroll)
        rerender(<ThinkingRow {...rowProps} reasoningContent="Second" />)
        expect(scroll.scrollTop).toBe(750)
    })

    it("starts static history at the top, preserves reading position, and resets only on reopening", () => {
        const props = { ...rowProps, isStreaming: false, reasoningContent: "History" }
        const { container, rerender } = render(<ThinkingRow {...props} />)
        const scroll = viewport(container)
        expect(scroll.scrollTop).toBe(0)
        scroll.scrollTop = 100
        fireEvent.scroll(scroll)
        rerender(<ThinkingRow {...props} reasoningContent="Updated history" />)
        expect(scroll.scrollTop).toBe(100)
        rerender(<ThinkingRow {...props} isExpanded={false} />)
        rerender(<ThinkingRow {...props} />)
        expect(viewport(container).scrollTop).toBe(0)
    })

    it("keeps the last visible position when a streamed reply is stopped", () => {
        const { container, rerender } = render(<ThinkingRow {...rowProps} reasoningContent="First" />)
        const scroll = viewport(container)
        expect(scroll.scrollTop).toBe(450)
        rerender(<ThinkingRow {...rowProps} isStreaming={false} reasoningContent="First" />)
        expect(scroll.scrollTop).toBe(450)
    })

    it("follows delayed content reflow only while following, and disconnects on collapse", () => {
        const disconnect = vi.fn()
        const observe = vi.fn()
        vi.stubGlobal(
            "ResizeObserver",
            class {
                constructor(callback: ResizeObserverCallback) {
                    resizeCallbacks.push(callback)
                }
                observe = observe
                disconnect = disconnect
            },
        )
        const { container, rerender } = render(<ThinkingRow {...rowProps} reasoningContent="First" />)
        const scroll = viewport(container)
        expect(observe.mock.calls.map(([element]) => element)).toEqual([scroll, scroll.firstElementChild])
        const resized = () => resizeCallbacks.at(-1)?.([], {} as ResizeObserver)
        height = 900
        act(resized)
        expect(scroll.scrollTop).toBe(750)
        scroll.scrollTop = 100
        fireEvent.scroll(scroll)
        height = 1200
        act(resized)
        expect(scroll.scrollTop).toBe(100)
        rerender(<ThinkingRow {...rowProps} isExpanded={false} />)
        expect(disconnect).toHaveBeenCalled()
        scroll.scrollTop = 90
        act(resized)
        expect(scroll.scrollTop).toBe(90)
    })
})
