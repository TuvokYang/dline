import { act, render, screen } from "@testing-library/react"
import React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ChatRowContent } from "../ChatRow"

void React

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		backgroundEditEnabled: false,
		mcpServers: [],
		mcpMarketplaceCatalog: [],
		onRelinquishControl: () => () => undefined,
		vscodeTerminalExecutionMode: "backgroundExec",
		clineMessages: [],
		showFeatureTips: false,
		taskViewState: undefined,
		currentTaskItem: { id: "task-1" },
	}),
}))

const startedAt = 1_000_000
const baseProps = {
	isExpanded: false,
	isLast: true,
	onSetQuote: vi.fn(),
	onToggleExpand: vi.fn(),
}

function renderRetry(failed = false) {
	return render(
		<ChatRowContent
			{...baseProps}
			message={{
				ts: startedAt,
				type: "say",
				say: "error_retry",
				text: JSON.stringify({
					attempt: 1,
					maxAttempts: 5,
					delaySeconds: 3,
					errorMessage: "Connection error.",
					failed,
				}),
			}}
		/>,
	)
}

describe("ChatRow automatic retry status", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(startedAt)
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("keeps retry details semantically separated for copying", () => {
		renderRetry()

		expect(screen.getByTestId("error-retry-countdown").textContent).toBe("Attempt 1 of 5 Next retry in 3s")
	})

	it("shows an in-progress state instead of scheduled zero seconds after the deadline", () => {
		renderRetry()

		act(() => vi.advanceTimersByTime(3_000))

		expect(screen.getByText("Automatic retry in progress", { exact: true })).toBeVisible()
		expect(screen.getByTestId("error-retry-countdown").textContent).toBe("Attempt 1 of 5 Retrying now")
		expect(screen.queryByText(/0s/)).toBeNull()
	})

	it("shows a terminal stopped state after all automatic attempts are exhausted", () => {
		renderRetry(true)

		expect(screen.getByText("Automatic retry stopped", { exact: true })).toBeVisible()
		expect(screen.getByTestId("error-retry-countdown").textContent).toBe("All 5 automatic attempts were used.")
	})
})
