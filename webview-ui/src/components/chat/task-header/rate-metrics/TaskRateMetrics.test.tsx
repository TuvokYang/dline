import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { TaskRateMetrics } from "./TaskRateMetrics"

const defaultProps = {
    cacheHitRate: 0,
    cacheReads: 0,
    cacheWrites: 0,
    currency: "USD",
    isCostAvailable: false,
    requestsPerMinute: 3,
    taskId: "task-1",
    tokensOut: 250,
    tokensPerMinute: 4_500,
    totalCost: 0,
    totalInputTokens: 1_250,
}

describe("TaskRateMetrics", () => {
    it("renders one unified capsule with In/Out before secondary rate metrics", () => {
        render(<TaskRateMetrics {...defaultProps} />)

        const button = screen.getByRole("button", { name: /View API rate history/ })
        expect(button).toHaveAttribute("id", "price-tag")
        expect(button).toHaveAttribute("title", "In: 1250 / Out: 250 / Cache read: 0 / Cache write: 0")
        expect(button).toHaveTextContent("In:1.3K")
        expect(button).toHaveTextContent("Out:250")
        expect(button).toHaveTextContent("RPM:3")
        expect(button).toHaveTextContent("TPM:4.5K")
        expect(button).toHaveTextContent("Hit:0.0%")
        expect(button).toHaveAccessibleName(/RPM: 3/)
        expect(button).toHaveAccessibleName(/TPM: 4500/)
        expect(button).not.toHaveAccessibleName(/Request/i)
        expect(button).toHaveAccessibleName(/Hit: 0\.0%/)
        expect(button.textContent?.indexOf("In:1.3K")).toBeLessThan(button.textContent?.indexOf("RPM:3") ?? -1)
        expect(button.querySelectorAll("button")).toHaveLength(0)
        expect(button).toHaveClass("rounded-full", "bg-success/80", "text-background")
    })

    it("opens history without bubbling click or keyboard activation to the Task header", async () => {
        const parentClick = vi.fn()
        const user = userEvent.setup()
        render(
            <div onClick={parentClick} onKeyDown={parentClick}>
                <TaskRateMetrics {...defaultProps} />
            </div>,
        )

        const button = screen.getByRole("button", { name: /View API rate history/ })
        fireEvent.click(button)
        expect(screen.getByRole("dialog", { name: "API Rate History" })).toBeInTheDocument()
        expect(parentClick).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole("button", { name: "Close" }))
        parentClick.mockClear()
        button.focus()
        await user.keyboard("{Enter}")
        expect(screen.getByRole("dialog", { name: "API Rate History" })).toBeInTheDocument()
        expect(parentClick).not.toHaveBeenCalled()
    })
})
