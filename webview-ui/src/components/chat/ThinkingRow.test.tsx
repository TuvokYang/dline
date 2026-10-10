import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ThinkingRow } from "./ThinkingRow"

describe("ThinkingRow", () => {
    it("renders streaming title styling and expanded reasoning content", () => {
        render(
            <ThinkingRow
                isExpanded={true}
                isStreaming={true}
                isVisible={true}
                reasoningContent="Inspecting files..."
                showTitle={true}
                title="Thinking..."
            />,
        )

        const title = screen.getByText("Thinking...")
        expect(title).toBeInTheDocument()
        expect(title).toHaveClass("animate-shimmer")
        expect(screen.getByText("Inspecting files...")).toBeInTheDocument()
    })

    it("animates a contentless row for encrypted reasoning", () => {
        // Encrypted reasoning has no renderable payload, but the user still needs
        // to see that the model is working.
        render(
            <ThinkingRow
                isExpanded={false}
                isStreaming={true}
                isVisible={true}
                reasoningContent={undefined}
                showChevron={false}
                showTitle={true}
                title="Waiting..."
            />,
        )

        const title = screen.getByText("Waiting...")
        expect(title).toBeInTheDocument()
        expect(title).toHaveClass("animate-shimmer")
    })

    it("calls onToggle when header is clicked", () => {
        const onToggle = vi.fn()

        render(
            <ThinkingRow
                isExpanded={false}
                isVisible={true}
                onToggle={onToggle}
                reasoningContent="some reasoning"
                showTitle={true}
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: /Thinking/i }))
        expect(onToggle).toHaveBeenCalledTimes(1)
    })
})
