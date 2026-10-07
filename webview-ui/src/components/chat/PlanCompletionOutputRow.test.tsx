// @vitest-environment jsdom

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import PlanCompletionOutputRow from "./PlanCompletionOutputRow"

describe("PlanCompletionOutputRow height boundary", () => {
	it("caps the whole plan card at 80 percent of the viewport and scrolls only the body", () => {
		render(<PlanCompletionOutputRow text={Array.from({ length: 100 }, (_, index) => `Plan line ${index + 1}`).join("\n")} />)

		expect(screen.getByTestId("plan-completion-card")).toHaveClass("max-h-[80vh]", "overflow-hidden")
		expect(screen.getByTestId("plan-completion-scroll")).toHaveClass(
			"min-h-0",
			"flex-auto",
			"overflow-y-auto",
			"overscroll-x-contain",
		)
	})
})
