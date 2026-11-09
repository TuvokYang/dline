// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import ReasoningEffortSelector from "./ReasoningEffortSelector"

describe("ReasoningEffortSelector declared options", () => {
    it("keeps original effort labels and values while the interface switches language", () => {
        const onChange = vi.fn()
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <ReasoningEffortSelector
                    allowedEfforts={["low", "high", "max"]}
                    onReasoningEffortChange={onChange}
                    reasoningEffort="high"
                />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const selector = screen.getByRole("combobox")
        for (const language of ["zh-CN", "en"] as const) {
            view.rerender(tree(language))
            expect(screen.getByRole("combobox")).toBe(selector)
            expect(selector).toHaveTextContent("High")
            fireEvent.click(selector)
            expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual(["Low", "High", "Max"])
            fireEvent.click(screen.getByRole("option", { name: "Max", exact: true }))
            expect(onChange).toHaveBeenLastCalledWith("max")
        }
    })

    it("preserves a declared provider-specific effort through the actual menu", () => {
        const onChange = vi.fn()
        render(
            <ReasoningEffortSelector
                allowedEfforts={["low", "custom"]}
                onReasoningEffortChange={onChange}
                reasoningEffort="low"
            />,
        )
        fireEvent.click(screen.getByRole("combobox"))
        fireEvent.click(screen.getByRole("option", { name: "Custom" }))
        expect(onChange).toHaveBeenCalledWith("custom")
    })

    it("does not render a selector for an explicitly empty declaration", () => {
        render(<ReasoningEffortSelector allowedEfforts={[]} onReasoningEffortChange={vi.fn()} />)
        expect(screen.queryByRole("combobox")).not.toBeInTheDocument()
    })
})
