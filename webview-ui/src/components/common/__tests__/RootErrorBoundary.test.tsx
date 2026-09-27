import { render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const reportWebviewError = vi.hoisted(() => vi.fn())
vi.mock("@/services/webviewErrorReporter", () => ({ reportWebviewError }))

import { RootErrorBoundary } from "../RootErrorBoundary"

const Thrower = () => {
	throw new Error("render exploded")
}

describe("RootErrorBoundary", () => {
	beforeEach(() => {
		reportWebviewError.mockReset()
		// React logs caught render errors; keep the test output readable.
		vi.spyOn(console, "error").mockImplementation(() => undefined)
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("renders children when nothing throws", () => {
		render(
			<RootErrorBoundary>
				<div>healthy panel</div>
			</RootErrorBoundary>,
		)
		expect(screen.getByText("healthy panel")).toBeTruthy()
		expect(screen.queryByTestId("root-error-boundary")).toBeNull()
		expect(reportWebviewError).not.toHaveBeenCalled()
	})

	it("replaces an unmounted tree with a visible error and reload action, and reports it once", () => {
		render(
			<RootErrorBoundary>
				<Thrower />
			</RootErrorBoundary>,
		)
		expect(screen.getByTestId("root-error-message").textContent).toBe("render exploded")
		expect(screen.getByTestId("root-error-reload")).toBeTruthy()
		expect(reportWebviewError).toHaveBeenCalledTimes(1)
		expect(reportWebviewError).toHaveBeenCalledWith(
			"render",
			expect.objectContaining({ message: "render exploded" }),
			expect.any(String),
		)
	})
})
