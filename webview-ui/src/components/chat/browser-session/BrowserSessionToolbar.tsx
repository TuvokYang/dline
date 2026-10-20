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
    padding: "4px 8px",
    borderTop: "1px solid var(--vscode-editorGroup-border)",
}

const navigationStyle: CSSProperties = { display: "flex", alignItems: "center", gap: "6px", marginLeft: "auto" }
const buttonGroupStyle: CSSProperties = { display: "flex", alignItems: "center", gap: "2px" }
const stepStyle: CSSProperties = { color: "var(--vscode-descriptionForeground)", fontSize: "12px" }

/** Page navigation at the bottom of the browser frame. */
export function BrowserSessionToolbar({ currentPageIndex, pageCount, onNext, onPrevious }: BrowserSessionToolbarProps) {
    const hasPages = pageCount > 1
    if (!hasPages) return null

    return (
        <div data-testid="browser-session-toolbar" style={toolbarStyle}>
            {hasPages && (
                <div style={navigationStyle}>
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
            )}
        </div>
    )
}
