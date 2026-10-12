// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FileServiceClient } from "@/services/grpc-client"
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

// Blocks jsdom's default navigation (which prints a "Not implemented" diagnostic)
// while still letting the React click handler run. Production external links
// must keep their default browser behavior.
function blockNavigation(link: HTMLElement): void {
    link.addEventListener("click", (event) => event.preventDefault(), { once: true })
}

describe("MarkdownBlock links", () => {
    beforeEach(() => {
        vi.mocked(FileServiceClient.openFileRelativePath).mockClear()
    })

    it("opens a project-relative PNG link and strips trailing bidi controls", () => {
        const filePath = "test-results/runtime/test-failed-1.png"
        render(<MarkdownBlock markdown={`[${filePath}](${filePath}\u200e)`} />)

        fireEvent.click(screen.getByRole("link", { name: filePath }))

        expect(FileServiceClient.openFileRelativePath).toHaveBeenCalledOnce()
        expect(FileServiceClient.openFileRelativePath).toHaveBeenCalledWith(expect.objectContaining({ value: filePath }))
    })

    it("decodes percent-encoded project-relative paths before opening", () => {
        render(<MarkdownBlock markdown="[screenshot](test-results/foo%20bar.png)" />)

        fireEvent.click(screen.getByRole("link", { name: "screenshot" }))

        expect(FileServiceClient.openFileRelativePath).toHaveBeenCalledWith(
            expect.objectContaining({ value: "test-results/foo bar.png" }),
        )
    })

    it("draws an entity link as the command a sent row ran only when the row opts in", () => {
        const markdown = "[/compact](#dline-entity/command/%2Fcompact) now"
        const { container } = render(<MarkdownBlock markdown={markdown} submittedEntities />)

        expect(container.querySelector(".mention-context-highlight-with-shadow")).toHaveTextContent("/compact")
        expect(screen.queryByRole("link", { name: "/compact" })).toBeNull()
    })

    // Model output is Markdown too; a link it writes must not pass for a command the user ran.
    it("keeps an entity link in other Markdown an ordinary link", () => {
        const { container } = render(<MarkdownBlock markdown="[/compact](#dline-entity/command/%2Fcompact)" />)

        expect(container.querySelector(".mention-context-highlight-with-shadow")).toBeNull()
        expect(screen.getByRole("link", { name: "/compact" })).toBeInTheDocument()
    })

    it("keeps absolute paths as plain links", () => {
        render(<MarkdownBlock markdown="[abs](/abs/path.png)" />)

        const link = screen.getByRole("link", { name: "abs" })
        expect(link).toHaveAttribute("href", "/abs/path.png")
        blockNavigation(link)
        fireEvent.click(link)

        expect(FileServiceClient.openFileRelativePath).not.toHaveBeenCalled()
    })

    it("keeps Windows drive paths inert (no local file open)", () => {
        render(<MarkdownBlock markdown="[win](<C:\\screenshots\\x.png>)" />)

        // react-markdown strips non-whitelisted protocols, leaving an empty href.
        const link = screen.getByText("win").closest("a")
        expect(link).not.toBeNull()
        expect(link?.getAttribute("href")).toBe("")
        blockNavigation(link!)
        fireEvent.click(link!)

        expect(FileServiceClient.openFileRelativePath).not.toHaveBeenCalled()
    })

    it("keeps hash anchors as plain links", () => {
        render(<MarkdownBlock markdown="[anchor](#summary)" />)

        const link = screen.getByRole("link", { name: "anchor" })
        blockNavigation(link)
        fireEvent.click(link)

        expect(FileServiceClient.openFileRelativePath).not.toHaveBeenCalled()
    })

    it("keeps external HTTPS links as browser links", () => {
        render(<MarkdownBlock markdown="[Dline](https://example.com/docs)" />)

        const link = screen.getByRole("link", { name: "Dline" })
        expect(link).toHaveAttribute("href", "https://example.com/docs")
        blockNavigation(link)
        fireEvent.click(link)

        expect(FileServiceClient.openFileRelativePath).not.toHaveBeenCalled()
    })

    it("renders a bare HTTPS URL as one non-nested link", () => {
        const { container } = render(<MarkdownBlock markdown="Read https://example.com/docs for details." />)

        const links = screen.getAllByRole("link", { name: "https://example.com/docs" })
        expect(links).toHaveLength(1)
        expect(links[0]).toHaveAttribute("href", "https://example.com/docs")
        expect(container.querySelector("a a")).toBeNull()
    })
})

describe("MarkdownBlock Act Mode content model", () => {
    it("keeps the interactive Act Mode hint inside valid phrasing content", () => {
        const { container } = render(<MarkdownBlock markdown="Please switch to Act Mode to continue." />)

        const control = screen.getByRole("button", { name: /Act Mode/ })
        expect(control.tagName).toBe("SPAN")
        expect(control.querySelector("div")).toBeNull()
        expect(control.closest("p")).not.toBeNull()
        expect(container.querySelector("p div")).toBeNull()
    })
})
