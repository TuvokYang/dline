// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"

import LatexBlock from "./LatexBlock"

const renderLatexToNode = vi.hoisted(() => vi.fn())

vi.mock("./latex-engine", () => ({
    LATEX_TEX_PACKAGES: ["base", "ams"],
    renderLatexToNode,
}))

function svgNode(marker: string): SVGSVGElement {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
    svg.setAttribute("data-marker", marker)
    return svg
}

// String.raw keeps backslashes literal so the LaTeX source in the test matches
// exactly what a fenced code block would contain.
const FRACTION_SOURCE = String.raw`\frac{a}{b}`
const BROKEN_SOURCE = String.raw`\begin{broken}`
const INTEGRAL_SOURCE = String.raw`\int_{0}^{\infty} e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}`
const UNKNOWN_MACRO_SOURCE = String.raw`\oops`

describe("LatexBlock", () => {
    beforeEach(() => {
        renderLatexToNode.mockReset()
    })

    it("typesets the source and mounts the returned node", async () => {
        renderLatexToNode.mockResolvedValue(svgNode("frac"))

        render(<LatexBlock code={FRACTION_SOURCE} />)

        await waitFor(() => {
            expect(screen.getByTestId("latex-block").querySelector("svg")).not.toBeNull()
        })
        // The engine must receive the source verbatim, with no escaping applied.
        expect(renderLatexToNode).toHaveBeenCalledTimes(1)
        expect(renderLatexToNode.mock.calls[0][0]).toBe(FRACTION_SOURCE)
        expect(screen.queryByTestId("latex-block-error")).toBeNull()
    })

    it("falls back to the raw source when typesetting fails", async () => {
        renderLatexToNode.mockRejectedValue(new Error("Undefined control sequence"))

        render(<LatexBlock code={BROKEN_SOURCE} />)

        const fallback = await screen.findByTestId("latex-block-error")
        expect(fallback.textContent).toBe(BROKEN_SOURCE)
        expect(screen.getByTestId("latex-block").querySelector("svg")).toBeNull()
    })

    it("copies the raw LaTeX source rather than the rendered output", async () => {
        renderLatexToNode.mockResolvedValue(svgNode("integral"))
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.assign(navigator, { clipboard: { writeText } })

        render(<LatexBlock code={INTEGRAL_SOURCE} />)

        await waitFor(() => {
            expect(screen.getByTestId("latex-block").querySelector("svg")).not.toBeNull()
        })

        await userEvent.click(screen.getByRole("button", { name: "Copy LaTeX source" }))

        expect(writeText).toHaveBeenCalledWith(INTEGRAL_SOURCE)
    })

    it("keeps the copy button available after a rendering failure", async () => {
        renderLatexToNode.mockRejectedValue(new Error("nope"))
        const writeText = vi.fn().mockResolvedValue(undefined)
        Object.assign(navigator, { clipboard: { writeText } })

        render(<LatexBlock code={UNKNOWN_MACRO_SOURCE} />)

        await screen.findByTestId("latex-block-error")
        await userEvent.click(screen.getByRole("button", { name: "Copy LaTeX source" }))

        expect(writeText).toHaveBeenCalledWith(UNKNOWN_MACRO_SOURCE)
    })

    it("re-typesets when the source changes and drops the stale result", async () => {
        let resolveFirst: ((node: Node) => void) | undefined
        renderLatexToNode.mockImplementationOnce(
            () =>
                new Promise<Node>((resolve) => {
                    resolveFirst = resolve
                }),
        )
        renderLatexToNode.mockResolvedValueOnce(svgNode("second"))

        const { rerender } = render(<LatexBlock code="a" />)
        rerender(<LatexBlock code="b" />)

        await waitFor(() => {
            expect(screen.getByTestId("latex-block").querySelector("svg[data-marker='second']")).not.toBeNull()
        })

        // The first render settles after the source already changed; its node must be discarded.
        resolveFirst?.(svgNode("first"))

        await waitFor(() => {
            expect(screen.getByTestId("latex-block").querySelector("svg[data-marker='first']")).toBeNull()
        })
        expect(screen.getByTestId("latex-block").querySelector("svg[data-marker='second']")).not.toBeNull()
    })

    it("clears the previous formula while the new source is being typeset", async () => {
        renderLatexToNode.mockResolvedValueOnce(svgNode("first"))
        let resolveSecond: ((node: Node) => void) | undefined
        renderLatexToNode.mockImplementationOnce(
            () =>
                new Promise<Node>((resolve) => {
                    resolveSecond = resolve
                }),
        )

        const { rerender } = render(<LatexBlock code="a" />)
        await waitFor(() => {
            expect(screen.getByTestId("latex-block").querySelector("svg[data-marker='first']")).not.toBeNull()
        })

        rerender(<LatexBlock code="b" />)

        // The stale formula must not stay next to the new source or its copy button.
        expect(screen.getByTestId("latex-block").querySelector("svg")).toBeNull()
        resolveSecond?.(svgNode("second"))
        await waitFor(() => {
            expect(screen.getByTestId("latex-block").querySelector("svg[data-marker='second']")).not.toBeNull()
        })
    })

    it("clears a previous failure while the new source is being typeset", async () => {
        renderLatexToNode.mockRejectedValueOnce(new Error("Undefined control sequence"))
        let resolveSecond: ((node: Node) => void) | undefined
        renderLatexToNode.mockImplementationOnce(
            () =>
                new Promise<Node>((resolve) => {
                    resolveSecond = resolve
                }),
        )

        const { rerender } = render(<LatexBlock code={BROKEN_SOURCE} />)
        await screen.findByTestId("latex-block-error")

        rerender(<LatexBlock code={FRACTION_SOURCE} />)

        // A valid formula must never be shown as an error while it is still rendering.
        expect(screen.queryByTestId("latex-block-error")).toBeNull()
        expect(screen.getByTestId("latex-block")).not.toHaveAttribute("hidden")
        resolveSecond?.(svgNode("recovered"))
        await waitFor(() => {
            expect(screen.getByTestId("latex-block").querySelector("svg[data-marker='recovered']")).not.toBeNull()
        })
    })

    it("does not write to the container after unmount", async () => {
        let resolvePending: ((node: Node) => void) | undefined
        renderLatexToNode.mockImplementation(
            () =>
                new Promise<Node>((resolve) => {
                    resolvePending = resolve
                }),
        )
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

        render(<LatexBlock code={String.raw`\alpha`} />)
        const container = screen.getByTestId("latex-block")
        const replaceChildren = vi.spyOn(container, "replaceChildren")

        cleanup()
        resolvePending?.(svgNode("late"))
        await Promise.resolve()
        await Promise.resolve()

        expect(replaceChildren).not.toHaveBeenCalled()
        expect(errorSpy).not.toHaveBeenCalled()
        errorSpy.mockRestore()
    })

    it("does not write to the container after a late rejection", async () => {
        let rejectPending: ((error: Error) => void) | undefined
        renderLatexToNode.mockImplementation(
            () =>
                new Promise<Node>((_resolve, reject) => {
                    rejectPending = reject
                }),
        )
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined)

        render(<LatexBlock code={String.raw`\beta`} />)
        const container = screen.getByTestId("latex-block")
        const replaceChildren = vi.spyOn(container, "replaceChildren")

        cleanup()
        rejectPending?.(new Error("late failure"))
        await Promise.resolve()
        await Promise.resolve()

        expect(replaceChildren).not.toHaveBeenCalled()
        expect(errorSpy).not.toHaveBeenCalled()
        errorSpy.mockRestore()
    })
})
