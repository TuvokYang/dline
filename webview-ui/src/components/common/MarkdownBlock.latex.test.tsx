// @vitest-environment jsdom

import { render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import MarkdownBlock from "./MarkdownBlock"

vi.mock("@/services/grpc-client", () => ({
    FileServiceClient: {
        openFileRelativePath: vi.fn(async () => ({})),
        ifFileExistsRelativePath: vi.fn(async () => ({ value: false })),
    },
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ mode: "act", stateRevision: 1, modeSwitch: undefined }),
}))

vi.mock("@/components/chat/mode-switch/useModeSwitch", () => ({
    useModeSwitch: () => ({ isSwitchPending: false, requestSwitch: vi.fn() }),
}))

vi.mock("@/components/common/MermaidBlock", () => ({
    default: ({ code }: { code: string }) => <div data-testid="mermaid-block">{code}</div>,
}))

vi.mock("@/components/common/LatexBlock", () => ({
    default: ({ code }: { code: string }) => <div data-testid="latex-block-stub">{code}</div>,
}))

const FORMULA = String.raw`\frac{a}{b}`

function fence(language: string, body: string): string {
    return ["```" + language, body, "```"].join("\n")
}

describe("MarkdownBlock latex routing", () => {
    it.each(["latex", "math", "tex"])("routes a %s fenced block to LatexBlock", async (language) => {
        render(<MarkdownBlock markdown={fence(language, FORMULA)} />)

        const block = await screen.findByTestId("latex-block-stub")
        expect(block.textContent).toBe(FORMULA)
    })

    it("passes multi-line formulas through as a single block", async () => {
        const source = [String.raw`\begin{align}`, String.raw`a &= b \\`, String.raw`c &= d`, String.raw`\end{align}`].join("\n")

        render(<MarkdownBlock markdown={fence("latex", source)} />)

        const block = await screen.findByTestId("latex-block-stub")
        expect(block.textContent).toBe(source)
    })

    it("does not wrap the formula in a <pre> element", async () => {
        const { container } = render(<MarkdownBlock markdown={fence("latex", FORMULA)} />)

        await screen.findByTestId("latex-block-stub")
        expect(container.querySelector("pre")).toBeNull()
    })

    it("keeps mermaid blocks on the diagram path", async () => {
        render(<MarkdownBlock markdown={fence("mermaid", "graph TD; A-->B;")} />)

        const block = await screen.findByTestId("mermaid-block")
        expect(block.textContent?.trim()).toBe("graph TD; A-->B;")
        expect(screen.queryByTestId("latex-block-stub")).toBeNull()
    })

    it("keeps ordinary code blocks as highlighted code", async () => {
        const { container } = render(<MarkdownBlock markdown={fence("javascript", "const x = 1")} />)

        await waitFor(() => {
            expect(container.querySelector("pre")).not.toBeNull()
        })
        expect(screen.queryByTestId("latex-block-stub")).toBeNull()
    })

    it("does not typeset inline code that looks like a formula", async () => {
        render(<MarkdownBlock markdown={"Use `\\frac{a}{b}` inline."} />)

        await waitFor(() => {
            expect(screen.queryByTestId("latex-block-stub")).toBeNull()
        })
    })

    it("keeps an unterminated latex fence out of the math renderer", async () => {
        const streaming = ["```latex", String.raw`\frac{a}{b`].join("\n")

        const { container } = render(<MarkdownBlock markdown={streaming} />)

        // Both marked and CommonMark close a fence implicitly at EOF, so the block would
        // otherwise be typeset from a half-written formula on every streaming chunk.
        await waitFor(() => {
            expect(container.querySelector("pre")).not.toBeNull()
        })
        expect(screen.queryByTestId("latex-block-stub")).toBeNull()
        expect(container.textContent).toContain(String.raw`\frac{a}{b`)
    })

    it("typesets the formula once the closing fence arrives", async () => {
        const streaming = ["```latex", String.raw`\frac{a}{b`].join("\n")
        const { rerender } = render(<MarkdownBlock markdown={streaming} />)
        await waitFor(() => {
            expect(screen.queryByTestId("latex-block-stub")).toBeNull()
        })

        rerender(<MarkdownBlock markdown={fence("latex", FORMULA)} />)

        const block = await screen.findByTestId("latex-block-stub")
        expect(block.textContent).toBe(FORMULA)
        expect(screen.getAllByTestId("latex-block-stub")).toHaveLength(1)
    })

    it("typesets a math fence written with tildes", async () => {
        render(<MarkdownBlock markdown={["~~~math", FORMULA, "~~~"].join("\n")} />)

        const block = await screen.findByTestId("latex-block-stub")
        expect(block.textContent).toBe(FORMULA)
    })

    it("keeps an unterminated tilde math fence out of the math renderer", async () => {
        render(<MarkdownBlock markdown={["~~~math", FORMULA].join("\n")} />)

        await waitFor(() => {
            expect(screen.queryByTestId("latex-block-stub")).toBeNull()
        })
    })

    it("typesets a formula whose body contains a shorter fence run", async () => {
        const source = ["````latex", FORMULA, "````"].join("\n")

        render(<MarkdownBlock markdown={source} />)

        const block = await screen.findByTestId("latex-block-stub")
        expect(block.textContent).toBe(FORMULA)
    })
})
