// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ReasoningEffortSelector from "./ReasoningEffortSelector"

describe("ReasoningEffortSelector declared options", () => {
	it("leaves an undeclared default unset instead of inventing medium", () => {
		render(<ReasoningEffortSelector allowedEfforts={["low", "medium"]} onReasoningEffortChange={vi.fn()} />)
		expect(screen.getByRole("combobox")).toHaveTextContent("Provider default")
	})

	it("does not display an unknown persisted preference as a legal option", () => {
		render(<ReasoningEffortSelector allowedEfforts={["low"]} onReasoningEffortChange={vi.fn()} reasoningEffort="high" />)
		expect(screen.getByRole("combobox")).toHaveTextContent("Provider default")
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
