import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { HistoryTaskOpeningView } from "./HistoryTaskOpeningView"

const target = { id: "saved", task: "Saved task title" }

describe("HistoryTaskOpeningView", () => {
	it("shows neutral progress without exposing task text before the task opens", () => {
		render(<HistoryTaskOpeningView opening={{ target, status: "loading", requestId: 1 }} />)

		expect(screen.getByRole("status")).toHaveTextContent("Opening task")
		expect(screen.queryByText(target.task)).not.toBeInTheDocument()
		expect(screen.queryByRole("button")).not.toBeInTheDocument()
	})
})
