import "@testing-library/jest-dom/vitest"
import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import NewTaskPreview from "./NewTaskPreview"

vi.mock("../common/MarkdownBlock", () => ({
    default: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))

describe("NewTaskPreview", () => {
    it.each([
        ["plan", "PLAN"],
        ["act", "ACT"],
    ] as const)("shows the selected %s startup mode", (mode, label) => {
        render(<NewTaskPreview mode={mode} task="Review the implementation" />)

        const modeRow = screen.getByTestId("new-task-mode")
        expect(modeRow).toHaveTextContent("Mode")
        expect(modeRow).toHaveTextContent(label)
    })

    it("keeps legacy previews without a mode readable", () => {
        render(<NewTaskPreview task="Legacy task" />)

        expect(screen.queryByTestId("new-task-mode")).not.toBeInTheDocument()
        expect(screen.getByText("Legacy task")).toBeInTheDocument()
    })
})
