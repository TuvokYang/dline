import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FocusChain } from "./FocusChain"

const extensionState = {
    focusChainHistory: "",
}

vi.mock("@context/ExtensionStateContext", () => ({
    useExtensionState: () => extensionState,
}))

vi.mock("services/grpc-client", () => ({
    FileServiceClient: {
        openFocusChainFile: vi.fn(),
    },
}))

const currentChecklist = `# Current task
## Work
- [x] Inspect the current behavior
- [ ] Verify the fixed behavior`

function expandFocusChain(): void {
    fireEvent.click(screen.getByLabelText("Expand focus chain"))
}

describe("FocusChain history and layout", () => {
    beforeEach(() => {
        extensionState.focusChainHistory = ""
    })

    it("renders history items that follow a title without a section heading", () => {
        extensionState.focusChainHistory = `# Focus Chain History for Task task-1

## Completed — 2026-08-21 19:39:51 UTC+8
# Provider and model configuration investigation
- [x] Inspect provider selection
- [ ] Verify model context size`

        render(<FocusChain lastProgressMessageText={currentChecklist} />)
        expandFocusChain()

        const history = screen.getByTestId("focus-chain-history")
        expect(within(history).getByText("Provider and model configuration investigation")).toBeVisible()
        expect(within(history).getByText("Inspect provider selection")).toBeVisible()
        expect(within(history).getByText("Verify model context size")).toBeVisible()
    })

    it("keeps titled and untitled history sections in the same entry", () => {
        extensionState.focusChainHistory = `## Completed — 2026-08-21 22:52:46 UTC+8
# Repair OpenRouter and Service Tier defects
- [x] Preserve the ungrouped finding
## Verification
- [x] Run focused tests`

        render(<FocusChain lastProgressMessageText={currentChecklist} />)
        expandFocusChain()

        const history = screen.getByTestId("focus-chain-history")
        expect(within(history).getByText("Preserve the ungrouped finding")).toBeVisible()
        expect(within(history).getByText("Verification")).toBeVisible()
        expect(within(history).getByText("Run focused tests")).toBeVisible()
    })

    it("bounds the complete expanded content in one visible scroll panel", () => {
        extensionState.focusChainHistory = `## Completed — 2026-08-21 19:39:51 UTC+8
# Historical task
- [x] Historical item`

        render(<FocusChain lastProgressMessageText={currentChecklist} />)
        expandFocusChain()

        const expandedContent = screen.getByTestId("focus-chain-expanded-content")
        const history = screen.getByTestId("focus-chain-history")

        expect(expandedContent).toHaveClass("focus-chain-scrollable", "scrollable", "max-h-[40vh]", "overflow-y-auto")
        expect(history).not.toHaveClass("max-h-[40vh]", "overflow-y-auto", "scrollable")
        expect(expandedContent).toContainElement(history)
    })

    it("keeps the progress bar attached to a compact header when expanded", () => {
        render(<FocusChain lastProgressMessageText={currentChecklist} />)
        expandFocusChain()

        const header = screen.getByTitle("Current task")
        const progressBar = header.firstElementChild

        expect(header).toHaveClass("relative", "w-full", "shrink-0")
        expect(header).not.toHaveClass("h-full")
        expect(progressBar).not.toBeNull()
        expect(header).toContainElement(progressBar as HTMLElement)
        expect(progressBar).toHaveClass("absolute", "bottom-0")
    })
})
