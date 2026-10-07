import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import ContextWindow from "./ContextWindow"

class TestResizeObserver implements ResizeObserver {
	disconnect = vi.fn()
	observe = vi.fn()
	unobserve = vi.fn()
}

globalThis.ResizeObserver = TestResizeObserver

describe("ContextWindow metrics", () => {
	it("renders context usage without owning the compact action", () => {
		render(<ContextWindow contextWindow={128_000} lastApiReqTotalTokens={64_000} useAutoCondense={false} />)

		expect(screen.getByRole("progressbar", { name: "Context window usage progress" })).toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Compact task" })).not.toBeInTheDocument()
	})

	it("renders legacy history totals in green and reports unavailable segment details", () => {
		render(<ContextWindow contextWindow={128_000} lastApiReqTotalTokens={64_000} useAutoCondense={false} />)

		const progress = screen.getByRole("progressbar", { name: "Context window usage progress" })
		expect(progress.firstElementChild?.getAttribute("style")).toContain("var(--vscode-charts-green, #3fb950)")
		fireEvent.mouseEnter(screen.getByTestId("context-window-progress-track"))
		expect(screen.getByText("Segment details unavailable for this saved task.")).toBeInTheDocument()
		expect(document.querySelector('[data-context-summary-metric="used"]')?.getAttribute("style")).toContain(
			"var(--vscode-charts-green, #3fb950)",
		)
		expect(screen.queryByTestId("context-window-segment-details")).not.toBeInTheDocument()
	})

	it("keeps the compact action disabled in the context row when compaction cannot re-enter", () => {
		const onCompactTask = vi.fn(async () => true)
		render(
			<ContextWindow
				compactTaskDisabled
				contextWindow={128_000}
				lastApiReqTotalTokens={64_000}
				onCompactTask={onCompactTask}
				useAutoCondense={false}
			/>,
		)

		const compactButton = screen.getByRole("button", { name: "Compact task" })
		expect(compactButton).toHaveAttribute("aria-disabled", "true")
		fireEvent.click(compactButton)
		expect(screen.queryByText("Compact the current task?")).not.toBeInTheDocument()
		expect(onCompactTask).not.toHaveBeenCalled()
	})

	it("dispatches the compact action from the context row after confirmation", async () => {
		const onCompactTask = vi.fn(async () => true)
		render(
			<ContextWindow
				contextWindow={128_000}
				lastApiReqTotalTokens={64_000}
				onCompactTask={onCompactTask}
				useAutoCondense={false}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Compact task" }))
		expect(screen.getByText("Compact the current task?")).toBeInTheDocument()
		fireEvent.click(screen.getByTitle("Yes, compact the task"))

		await waitFor(() => expect(onCompactTask).toHaveBeenCalledOnce())
		await waitFor(() => expect(screen.queryByText("Compact the current task?")).not.toBeInTheDocument())
	})

	it("does not render Force Truncate actions without an explicit backend availability signal", () => {
		const onForceTruncateTask = vi.fn(async () => true)
		render(
			<ContextWindow
				contextWindow={128_000}
				lastApiReqTotalTokens={64_000}
				onForceTruncateTask={onForceTruncateTask}
				useAutoCondense
			/>,
		)

		expect(screen.queryByRole("button", { name: "More context actions" })).not.toBeInTheDocument()
		expect(screen.queryByText("Force truncate conversation history")).not.toBeInTheDocument()
	})

	it("requires the guarded menu and exact TRUNCATE confirmation before force truncation", async () => {
		const onCompactTask = vi.fn(async () => true)
		const onForceTruncateTask = vi.fn(async () => true)
		render(
			<ContextWindow
				contextWindow={128_000}
				forceTruncateAvailable
				lastApiReqTotalTokens={64_000}
				onCompactTask={onCompactTask}
				onForceTruncateTask={onForceTruncateTask}
				useAutoCondense
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "More context actions" }))
		const menuAction = screen.getByRole("button", { name: "Force truncate conversation history", exact: true })
		fireEvent.click(menuAction)

		expect(screen.getByRole("dialog")).toBeInTheDocument()
		expect(screen.getByLabelText("Type TRUNCATE to confirm")).toHaveValue("")
		expect(onForceTruncateTask).not.toHaveBeenCalled()

		const confirmButton = screen.getByText("Force truncate conversation history", { exact: true })
		expect(confirmButton.querySelector("input[disabled]")).toBeInTheDocument()

		fireEvent.change(screen.getByLabelText("Type TRUNCATE to confirm"), { target: { value: "TRUNCATE" } })
		expect(confirmButton.querySelector("input[disabled]")).not.toBeInTheDocument()
		fireEvent.click(confirmButton)

		await waitFor(() => expect(onForceTruncateTask).toHaveBeenCalledOnce())
		expect(onCompactTask).not.toHaveBeenCalled()
		await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
	})

	it("owns a shrink-safe three-column layout so the progress track cannot collapse at narrow widths", () => {
		render(<ContextWindow contextWindow={128_000} lastApiReqTotalTokens={64_000} useAutoCondense={false} />)

		expect(screen.getByTestId("context-window-indicator")).toHaveClass("min-w-0", "w-full")
		expect(screen.getByTestId("context-window-progress-track")).toHaveClass("min-w-0", "w-full")
		expect(screen.getByTestId("context-window-progress-track").parentElement).toHaveClass(
			"grid",
			"grid-cols-[auto_minmax(2rem,1fr)_auto]",
			"min-w-0",
			"w-full",
		)
	})

	it("renders the authoritative four segments in durable, active, staged, ENV order", () => {
		render(
			<ContextWindow
				contextWindow={200_000}
				contextWindowIndicator={{
					taskId: "task-1",
					revision: 2,
					epoch: 1,
					phase: "receiving",
					durableContextTokens: 40_000,
					pendingSendTokens: 0,
					receivingTokens: 3_000,
					stagedTokens: 2_000,
					environmentTokens: 1_000,
					contextWindow: 100_000,
					mode: "act",
					updatedAt: 1,
					lineage: { kind: "baseline" },
				}}
				lastApiReqTotalTokens={90_000}
				useAutoCondense={false}
			/>,
		)

		const progress = screen.getByTestId("context-window-segmented-progress")
		expect(progress).not.toHaveAttribute("title")
		expect(screen.getByTestId("context-window-tooltip-trigger")).toContainElement(progress)
		expect(document.querySelectorAll('[data-slot="hover-card-content"]')).toHaveLength(0)
		expect(screen.getByTestId("context-window-segment-durable")).toHaveAttribute("aria-label", "Durable: 40000 tokens")
		expect(screen.getByTestId("context-window-segment-active")).toHaveAttribute("aria-label", "Receiving: 3000 tokens")
		expect(screen.getByTestId("context-window-segment-staged")).toHaveAttribute("aria-label", "Staged: 2000 tokens")
		expect(screen.getByTestId("context-window-segment-environment")).toHaveAttribute("aria-label", "ENV: 1000 tokens")
		for (const kind of ["durable", "active", "staged", "environment"] as const) {
			expect(screen.getByTestId(`context-window-segment-${kind}`)).not.toHaveAttribute("title")
		}
		expect(progress).toHaveAttribute("aria-valuenow", "46000")
		expect(progress).toHaveAttribute("aria-valuemax", "100000")
		fireEvent.mouseEnter(screen.getByTestId("context-window-progress-track"))
		for (const [kind, color] of [
			["durable", "green"],
			["active", "yellow"],
			["staged", "orange"],
			["environment", "purple"],
		]) {
			const segmentStyle = screen.getByTestId(`context-window-segment-${kind}`).getAttribute("style")
			const detailStyle = document.querySelector(`[data-segment-detail="${kind}"]`)?.getAttribute("style")
			expect(segmentStyle).toContain(`--vscode-charts-${color}`)
			expect(detailStyle).toContain(`--vscode-charts-${color}`)
		}
		expect(screen.queryByText("Segment details unavailable for this saved task.")).not.toBeInTheDocument()
	})

	it("opens the current snapshot immediately for the whole track and closes on mouse leave", async () => {
		render(
			<ContextWindow
				contextWindowIndicator={{
					taskId: "task-empty-hover",
					revision: 1,
					epoch: 1,
					phase: "receiving",
					durableContextTokens: 10_000,
					pendingSendTokens: 0,
					receivingTokens: 100,
					environmentTokens: 1_000,
					contextWindow: 100_000,
					mode: "act",
					updatedAt: 1,
					lineage: { kind: "baseline" },
				}}
				useAutoCondense={false}
			/>,
		)

		fireEvent.mouseEnter(screen.getByTestId("context-window-progress-track"))
		const surface = document.querySelector('[data-context-window-surface="summary"]')
		expect(surface).toHaveClass("w-72", "bg-menu", "text-code-foreground")
		expect(document.querySelectorAll('[data-slot="hover-card-content"]')).toHaveLength(1)
		expect(screen.getByTestId("context-window-summary")).toHaveClass("w-full")
		expect(screen.getByTestId("context-window-summary")).not.toHaveClass("w-72", "bg-menu", "p-2", "shadow-sm")

		fireEvent.mouseLeave(screen.getByTestId("context-window-indicator"))
		await waitFor(() => expect(document.querySelector('[data-slot="hover-card-content"]')).not.toBeInTheDocument())
	})

	it("renders nothing when context-window metrics are unavailable", () => {
		const { container } = render(<ContextWindow useAutoCondense={false} />)

		expect(container).toBeEmptyDOMElement()
	})
})
