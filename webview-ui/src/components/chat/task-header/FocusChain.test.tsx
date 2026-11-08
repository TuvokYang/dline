import type { UiLanguage } from "@shared/UiLanguage"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { FileServiceClient } from "@/services/grpc-client"
import { FocusChain } from "./FocusChain"

const extensionState = {
    focusChainHistory: "",
}

vi.mock("@context/ExtensionStateContext", () => ({
    useExtensionState: () => extensionState,
}))

vi.mock("@/services/grpc-client", () => ({
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
        vi.clearAllMocks()
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

    it("localizes only canonical completion headings while preserving history content and expansion", () => {
        const firstDate = "2026-08-21 19:39:51 UTC+8"
        const secondDate = "2026-08-20 10:20:30 UTC-5"
        const historyText = `# Focus Chain History for Task task-1
## Completed — ${firstDate}
# Completed — model title 原文
- [x] Keep ungrouped content
## Completed integration
- [x] Preserve model section 原文
## Completed — ${secondDate}
# Earlier task
## Verify 原文
- [ ] Completed — user task text`
        extensionState.focusChainHistory = historyText
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <FocusChain currentTaskItemId="task-1" lastProgressMessageText={currentChecklist} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        expandFocusChain()
        const expanded = screen.getByTestId("focus-chain-expanded-content")
        const history = screen.getByTestId("focus-chain-history")
        const firstHeading = within(history).getByText(`Completed — ${firstDate}`)
        const expectPreservedContent = () => {
            expect(screen.getByTestId("focus-chain-expanded-content")).toBe(expanded)
            expect(screen.getByTestId("focus-chain-history")).toBe(history)
            expect(history.children).toHaveLength(2)
            for (const text of [
                "Completed — model title 原文",
                "Keep ungrouped content",
                "Completed integration",
                "Preserve model section 原文",
                "Earlier task",
                "Verify 原文",
                "Completed — user task text",
            ]) {
                expect(within(history).getByText(text)).toBeVisible()
            }
            expect(extensionState.focusChainHistory).toBe(historyText)
            expect(FileServiceClient.openFocusChainFile).not.toHaveBeenCalled()
        }
        expectPreservedContent()

        view.rerender(tree("zh-CN"))
        expect(screen.getByLabelText("收起焦点链")).toBeVisible()
        expect(within(history).getByText(`已完成 — ${firstDate}`)).toBe(firstHeading)
        expect(within(history).getByText(`已完成 — ${secondDate}`)).toBeVisible()
        expectPreservedContent()

        view.rerender(tree("en"))
        expect(screen.getByLabelText("Collapse focus chain")).toBeVisible()
        expect(within(history).getByText(`Completed — ${firstDate}`)).toBe(firstHeading)
        expect(within(history).getByText(`Completed — ${secondDate}`)).toBeVisible()
        expectPreservedContent()
        fireEvent.click(within(history).getByText("Preserve model section 原文"))
        expect(FileServiceClient.openFocusChainFile).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ value: "task-1" }))
        expect(screen.getByTestId("focus-chain-expanded-content")).toBe(expanded)
    })

    it("bounds the complete expanded content in one visible scroll panel", () => {
        extensionState.focusChainHistory = `## Completed — 2026-08-21 19:39:51 UTC+8
# Historical task
- [x] Historical item`

        render(<FocusChain lastProgressMessageText={currentChecklist} />)
        expandFocusChain()

        const expandedContent = screen.getByTestId("focus-chain-expanded-content")
        const history = screen.getByTestId("focus-chain-history")

        expect(expandedContent).toContainElement(history)
    })

    it("keeps the progress bar attached to a compact header when expanded", () => {
        render(<FocusChain lastProgressMessageText={currentChecklist} />)
        expandFocusChain()

        const header = screen.getByTitle("Current task")
        const progressBar = header.firstElementChild

        expect(progressBar).not.toBeNull()
        expect(header).toContainElement(progressBar as HTMLElement)
    })
})
