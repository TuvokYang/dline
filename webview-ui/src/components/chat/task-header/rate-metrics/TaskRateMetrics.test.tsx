import { fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
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
        expect(button).toHaveAccessibleName(/RPM: 3/)
        expect(button).toHaveAccessibleName(/TPM: 4500/)
        expect(button).not.toHaveAccessibleName(/Request/i)
        expect(button).toHaveAccessibleName(/Cache: 0\.0%/)
        expect(button.textContent?.indexOf("In:1.3K")).toBeLessThan(button.textContent?.indexOf("RPM:3") ?? -1)
        expect(button.querySelectorAll("button")).toHaveLength(0)
    })

    it("retranslates the cache percentage in place without changing its value or focus", () => {
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <TaskRateMetrics {...defaultProps} cacheHitRate={42.57} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const button = screen.getByRole("button", { name: /Cache: 42\.6%/ })
        expect(button).toHaveTextContent("Cache:42.6%")
        button.focus()
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("button", { name: /缓存：42\.6%/ })).toBe(button)
        expect(button).toHaveTextContent("缓存:42.6%")
        expect(button).toHaveFocus()
        view.rerender(tree("en"))
        expect(screen.getByRole("button", { name: /Cache: 42\.6%/ })).toBe(button)
        expect(button).toHaveFocus()
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

    it("states the newest segment rather than a sum across currencies", () => {
        render(
            <TaskRateMetrics
                {...defaultProps}
                costSegments={[
                    { currency: "CNY", totalCost: 12.5 },
                    { currency: "USD", totalCost: 3 },
                ]}
                currency="USD"
                isCostAvailable={true}
                totalCost={15.5}
            />,
        )

        // 12.5 CNY and 3 USD share no unit, so the capsule states the newest segment
        // instead of a total that would have no currency at all.
        expect(screen.getByRole("button", { name: /Cost: \$3\.000/ })).toBeInTheDocument()
    })

    it("falls back to the newest labelled segment when the newest one has no currency", () => {
        render(
            <TaskRateMetrics
                {...defaultProps}
                costSegments={[
                    { currency: "CNY", totalCost: 12.5 },
                    { currency: "", totalCost: 0.4 },
                ]}
                currency={undefined}
                isCostAvailable={true}
                totalCost={12.9}
            />,
        )

        // An amount reported without a currency cannot be labelled, so the capsule
        // states the last amount that could be.
        expect(screen.getByRole("button", { name: /Cost: ¥12\.500/ })).toBeInTheDocument()
    })
})
