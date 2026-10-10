// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { BrowserSessionToolbar } from "./BrowserSessionToolbar"

void React

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeButton: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
        <button type="button" {...props}>
            {children}
        </button>
    ),
}))

describe("BrowserSessionToolbar", () => {
    it("renders accessible top-level page navigation", () => {
        const onPrevious = vi.fn()
        const onNext = vi.fn()
        render(<BrowserSessionToolbar currentPageIndex={1} onNext={onNext} onPrevious={onPrevious} pageCount={3} />)

        fireEvent.click(screen.getByRole("button", { name: "Previous browser step" }))
        fireEvent.click(screen.getByRole("button", { name: "Next browser step" }))
        expect(onPrevious).toHaveBeenCalledOnce()
        expect(onNext).toHaveBeenCalledOnce()
        expect(screen.getByText("Step 2 of 3")).toBeInTheDocument()
    })
})
