import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react"
import type { CSSProperties } from "react"

interface BrowserSessionToolbarProps {
    currentPageIndex: number
    pageCount: number
    onNext: () => void
    onPrevious: () => void
}

const toolbarStyle: CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    padding: "6px 8px",
    borderBottom: "1px solid var(--vscode-editorGroup-border)",
}

const buttonGroupStyle: CSSProperties = { display: "flex", alignItems: "center", gap: "2px" }
const stepStyle: CSSProperties = { color: "var(--vscode-descriptionForeground)", fontSize: "12px" }

export function BrowserSessionToolbar({ currentPageIndex, pageCount, onNext, onPrevious }: BrowserSessionToolbarProps) {
    if (pageCount <= 1) return null

    return (
        <div data-testid="browser-session-toolbar" style={toolbarStyle}>
            <span style={stepStyle}>
                Step {currentPageIndex + 1} of {pageCount}
            </span>
            <div style={buttonGroupStyle}>
                <VSCodeButton
                    appearance="icon"
                    aria-label="Previous browser step"
                    disabled={currentPageIndex === 0}
                    onClick={onPrevious}
                    title="Previous browser step">
                    <ChevronLeftIcon aria-hidden size={16} />
                </VSCodeButton>
                <VSCodeButton
                    appearance="icon"
                    aria-label="Next browser step"
                    disabled={currentPageIndex === pageCount - 1}
                    onClick={onNext}
                    title="Next browser step">
                    <ChevronRightIcon aria-hidden size={16} />
                </VSCodeButton>
            </div>
        </div>
    )
}
