import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { HistoryTaskOpeningView } from "./HistoryTaskOpeningView"

const target = { id: "saved", task: "Saved task title" }

describe("HistoryTaskOpeningView", () => {
	it("shows a title and accessible loading status without task actions", () => {
		render(
			<HistoryTaskOpeningView onBack={vi.fn()} onRetry={vi.fn()} opening={{ target, status: "loading", requestId: 1 }} />,
		)
		expect(screen.getByText(target.task)).toBeInTheDocument()
		expect(screen.getByRole("status")).toHaveTextContent("Opening task history")
		expect(screen.getByTestId("history-task-opening")).toHaveAttribute("aria-busy", "true")
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})

	it("offers retry and return navigation after a failure", () => {
		const onRetry = vi.fn()
		const onBack = vi.fn()
		render(<HistoryTaskOpeningView onBack={onBack} onRetry={onRetry} opening={{ target, status: "failed", requestId: 1 }} />)
		expect(screen.getByRole("alert")).toHaveTextContent("Could not open this task")
		fireEvent.click(screen.getByRole("button", { name: "Retry" }))
		fireEvent.click(screen.getByRole("button", { name: "Back to history" }))
		expect(onRetry).toHaveBeenCalledOnce()
		expect(onBack).toHaveBeenCalledOnce()
	})
})
