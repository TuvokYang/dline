// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FileServiceClient } from "@/services/grpc-client"
import {
	DEFAULT_TASK_ACTIVITY_FILTERS,
	formatCommandTimeout,
	type TaskActivityFilters,
	TaskActivityPanel,
} from "./TaskActivityPanel"

const { cancelTaskActivities, finishTaskActivities, retryTaskActivities, extraActivities } = vi.hoisted(() => ({
	cancelTaskActivities: vi.fn(),
	finishTaskActivities: vi.fn(),
	retryTaskActivities: vi.fn(),
	extraActivities: [] as Array<Record<string, unknown>>,
}))

function ActivitiesTabHarness() {
	const [tab, setTab] = useState<"work" | "activities">("work")
	const [filters, setFilters] = useState<TaskActivityFilters>(DEFAULT_TASK_ACTIVITY_FILTERS)

	return (
		<div>
			<button onClick={() => setTab("work")} type="button">
				Work
			</button>
			<button onClick={() => setTab("activities")} type="button">
				Activities
			</button>
			{tab === "activities" && <TaskActivityPanel filters={filters} onFiltersChange={setFilters} taskId="task-1" />}
		</div>
	)
}

function FocusActivityHarness() {
	const [focusActivityId, setFocusActivityId] = useState<string | undefined>("old-agent")
	const [filters, setFilters] = useState<TaskActivityFilters>(DEFAULT_TASK_ACTIVITY_FILTERS)

	return (
		<div>
			<TaskActivityPanel
				filters={filters}
				focusActivityId={focusActivityId}
				onFiltersChange={(nextFilters) => {
					setFilters(nextFilters)
					setFocusActivityId(undefined)
				}}
				taskId="task-1"
			/>
		</div>
	)
}

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: {
		openFile: vi.fn(async () => ({})),
	},
}))

vi.mock("./useTaskActivities", () => ({
	cancelTaskActivities: (...args: unknown[]) => cancelTaskActivities(...args),
	finishTaskActivities: (...args: unknown[]) => finishTaskActivities(...args),
	retryTaskActivities: (...args: unknown[]) => retryTaskActivities(...args),
	useTaskActivities: () => ({
		activities: [
			{
				activityId: "new-command",
				taskId: "task-1",
				kind: "command",
				executionMode: "background",
				status: "running",
				cancellable: true,
				createdAt: 200,
				updatedAt: 200,
				timeoutSeconds: 0,
				title: "new command",
				detail: "npm run test:run -- src/example.test.ts",
				logPath: "C:\\Temp\\activity.log",
				output: "actual stdout\nold progress\r\x1b[31mfailed\x1b[0m\tcolumn\b\n\x1b]0;C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\x1b\\\x1b[0m(base) \x1b[0m\n",
				events: [
					{
						sequence: 1,
						timestamp: 200,
						kind: "status",
						status: "running",
						text: "Activity started",
					},
					{
						sequence: 2,
						timestamp: 201,
						kind: "output",
						text: "actual stdout\n",
					},
					{
						sequence: 3,
						timestamp: 202,
						kind: "metrics",
						metrics: {
							toolCalls: 0,
							inputTokens: 0,
							outputTokens: 0,
							totalCost: 0,
							currency: "",
							contextTokens: 0,
							contextWindow: 0,
							lineCount: 1,
						},
					},
				],
			},
			{
				activityId: "stale-command",
				taskId: "task-1",
				kind: "command",
				executionMode: "background",
				status: "interrupted",
				cancellable: false,
				createdAt: 175,
				updatedAt: 180,
				finishedAt: 180,
				timeoutSeconds: -1,
				title: "stale command",
				latestEvent: "Interrupted before completion",
				events: [
					{
						sequence: 1,
						timestamp: 180,
						kind: "status",
						status: "interrupted",
						text: "Interrupted before completion",
					},
				],
			},
			{
				activityId: "skipped-command",
				taskId: "task-1",
				kind: "command",
				executionMode: "foreground",
				status: "skipped",
				cancellable: false,
				createdAt: 160,
				updatedAt: 160,
				finishedAt: 160,
				title: "skipped command",
				detail: "npm run skipped",
				latestEvent: "Skipped by user",
				events: [],
			},
			{
				activityId: "old-agent",
				taskId: "task-1",
				kind: "subagent",
				executionMode: "foreground",
				status: "completed",
				createdAt: 100,
				updatedAt: 150,
				finishedAt: 5_100,
				title: "old agent",
				metrics: { toolCalls: 1, inputTokens: 10, outputTokens: 5, totalCost: 0.01, currency: "USD" },
				events: [
					{
						sequence: 1,
						timestamp: 101,
						kind: "thinking",
						phase: "final",
						text: "Inspect the cancellation path.",
					},
					{
						sequence: 2,
						timestamp: 110,
						kind: "assistant_message",
						phase: "final",
						text: "I will read the executor.",
					},
					{
						sequence: 3,
						timestamp: 120,
						kind: "tool_call",
						toolCallId: "tid-1",
						toolName: "read_file",
						toolStatus: "completed",
						summary: "read executor",
						durationMs: 8,
					},
					{
						sequence: 4,
						timestamp: 121,
						kind: "tool_result",
						toolCallId: "tid-1",
						toolName: "read_file",
						text: "executor content",
					},
					{
						sequence: 5,
						timestamp: 140,
						kind: "metrics",
						metrics: { toolCalls: 1, inputTokens: 10, outputTokens: 5, totalCost: 0.01, currency: "USD" },
					},
				],
			},
			...extraActivities,
		],
	}),
}))

describe("TaskActivityPanel", () => {
	beforeEach(() => {
		cancelTaskActivities.mockClear()
		finishTaskActivities.mockClear()
		retryTaskActivities.mockClear()
		extraActivities.length = 0
		vi.mocked(FileServiceClient.openFile).mockClear()
		Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
			configurable: true,
			value: vi.fn(),
		})
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { writeText: vi.fn(async () => undefined) },
		})
	})

	it("formats command timeouts in seconds and hours", () => {
		expect(formatCommandTimeout(60)).toBe("60 s")
		expect(formatCommandTimeout(3600)).toBe("1.0 h")
	})

	it("expands and scrolls to an activity selected from the work view", async () => {
		render(<TaskActivityPanel focusActivityId="new-command" taskId="task-1" />)

		const item = screen
			.getAllByTestId("activity-item")
			.find((candidate) => candidate.getAttribute("data-activity-id") === "new-command") as HTMLElement
		expect(item).toHaveTextContent("actual stdout")
		await waitFor(() => expect(item.scrollIntoView).toHaveBeenCalledWith({ block: "center" }))
	})

	it("shows only the focused activity without changing the saved filters", () => {
		render(<TaskActivityPanel filters={{ status: "active", kind: "all" }} focusActivityId="old-agent" taskId="task-1" />)

		const items = screen.getAllByTestId("activity-item")
		expect(items).toHaveLength(1)
		expect(items[0]).toHaveAttribute("data-activity-id", "old-agent")
		expect(within(items[0]).getByTestId("subagent-tool-timeline")).toBeInTheDocument()
	})

	it("preserves filters when switching away from and back to Activities", () => {
		render(<ActivitiesTabHarness />)

		fireEvent.click(screen.getByRole("button", { name: "Activities" }))
		fireEvent.click(screen.getByTestId("activity-status-filter-all"))
		fireEvent.click(screen.getByTestId("activity-kind-filter-subagent"))
		expect(screen.getAllByTestId("activity-item")).toHaveLength(1)
		expect(screen.getByTestId("activity-item")).toHaveAttribute("data-activity-id", "old-agent")

		fireEvent.click(screen.getByRole("button", { name: "Work" }))
		expect(screen.queryByTestId("activity-list")).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Activities" }))

		expect(screen.getByTestId("activity-status-filter-all")).toHaveClass("border-link")
		expect(screen.getByTestId("activity-kind-filter-subagent")).toHaveClass("border-link")
		expect(screen.getByTestId("activity-item")).toHaveAttribute("data-activity-id", "old-agent")
	})

	it("releases a focused activity when the user changes a filter", () => {
		render(<FocusActivityHarness />)

		expect(screen.getByTestId("activity-item")).toHaveAttribute("data-activity-id", "old-agent")
		fireEvent.click(screen.getByTestId("activity-status-filter-all"))

		const items = screen.getAllByTestId("activity-item")
		expect(items).toHaveLength(4)
	})

	it("defaults to active activities in creation order and exposes exact cancellation", () => {
		render(<TaskActivityPanel taskId="task-1" taskInstanceId="task-instance-1" />)

		const items = screen.getAllByTestId("activity-item")
		expect(items).toHaveLength(1)
		expect(screen.getByTestId("activity-list")).toHaveClass("space-y-2")
		expect(items[0]).toHaveClass("border-editor-widget-border/60", "overflow-hidden")
		expect(within(items[0]).getByTestId("activity-header")).toHaveClass("bg-toolbar-hover/30")
		expect(within(items[0]).getByTestId("activity-status-accent")).toHaveClass("bg-link")
		expect(within(items[0]).getByText("new command")).toBeInTheDocument()
		expect(within(items[0]).getByText("new command")).toHaveClass("font-mono", "font-semibold")
		expect(within(items[0]).getByTestId("activity-kind-icon")).toHaveClass("lucide-terminal")
		expect(within(items[0]).getByTestId("activity-execution-mode")).toHaveTextContent("Background")
		expect(within(items[0]).getByTestId("activity-execution-mode")).toHaveClass(
			"bg-editor-warning-foreground/10",
			"text-editor-warning-foreground",
		)
		expect(within(items[0]).queryByLabelText(/Command timeout:/)).not.toBeInTheDocument()
		expect(within(items[0]).queryByText("Command", { exact: true })).not.toBeInTheDocument()
		const metadata = within(items[0]).getByTestId("activity-metadata")
		const environmentMode = within(items[0]).getByTestId("activity-environment-mode")
		const environmentLabel = within(items[0]).getByTestId("activity-environment-label")
		expect(environmentLabel).toHaveTextContent("(base)")
		expect(environmentMode).toHaveClass("w-fit", "max-w-full", "flex-nowrap")
		expect(environmentLabel).toHaveClass("max-w-[60%]", "flex-auto", "truncate")
		expect(environmentLabel.parentElement).toBe(environmentMode)
		expect(environmentMode.parentElement).toBe(metadata)
		expect(environmentMode.firstElementChild).toBe(environmentLabel)
		expect(environmentMode.lastElementChild).toBe(within(items[0]).getByTestId("activity-execution-mode"))
		const summary = within(items[0]).getByTestId("activity-output-summary")
		expect(summary.textContent).toBe("failed→   column⌫")
		expect(summary.textContent).not.toContain("\x1b")
		expect(summary).not.toHaveTextContent("old progress")

		const cancelButton = within(items[0]).getByRole("button", { name: "Cancel" })
		expect(cancelButton).toHaveClass("h-5", "self-center", "bg-[#c42b2b]", "text-white!", "text-[11px]")
		expect(cancelButton).not.toHaveClass("bg-button-background", "text-button-foreground", "hover:bg-button-hover")
		fireEvent.click(cancelButton)
		expect(cancelTaskActivities).toHaveBeenCalledWith("task-1", ["new-command"], "task-instance-1")
	})

	it("shows Finish and Retry only for capable subagent activities", async () => {
		extraActivities.push(
			{
				activityId: "running-agent",
				taskId: "task-1",
				kind: "subagent",
				executionMode: "background",
				status: "running",
				cancellable: true,
				finishable: true,
				retryable: false,
				createdAt: 250,
				updatedAt: 250,
				title: "running agent",
				events: [],
			},
			{
				activityId: "retry-agent",
				taskId: "task-1",
				kind: "subagent",
				executionMode: "background",
				status: "failed",
				cancellable: false,
				finishable: false,
				retryable: true,
				createdAt: 240,
				updatedAt: 240,
				finishedAt: 240,
				title: "retry agent",
				events: [],
			},
		)
		let resolveFinish!: () => void
		let resolveRetry!: () => void
		finishTaskActivities.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveFinish = resolve)))
		retryTaskActivities.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveRetry = resolve)))
		render(
			<TaskActivityPanel filters={{ status: "all", kind: "subagent" }} taskId="task-1" taskInstanceId="task-instance-1" />,
		)
		const finishButton = screen.getByRole("button", { name: "Finish" })
		const retryButton = screen.getByRole("button", { name: "Retry" })

		fireEvent.click(finishButton)
		fireEvent.click(finishButton)
		fireEvent.click(retryButton)
		fireEvent.click(retryButton)

		expect(finishTaskActivities).toHaveBeenCalledTimes(1)
		expect(finishTaskActivities).toHaveBeenCalledWith("task-1", ["running-agent"], "task-instance-1")
		expect(retryTaskActivities).toHaveBeenCalledTimes(1)
		expect(retryTaskActivities).toHaveBeenCalledWith("task-1", ["retry-agent"], "task-instance-1")
		expect(finishButton).toBeDisabled()
		expect(retryButton).toBeDisabled()
		expect(screen.getAllByRole("button", { name: "Finish" })).toHaveLength(1)
		expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1)
		resolveFinish()
		resolveRetry()
		await waitFor(() => {
			expect(finishButton).not.toBeDisabled()
			expect(retryButton).not.toBeDisabled()
		})
	})

	it("shows automatic retry timing in expanded subagent activity output", () => {
		extraActivities.push({
			activityId: "retry-history-agent",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "foreground",
			status: "failed",
			cancellable: false,
			finishable: false,
			retryable: true,
			createdAt: 240,
			updatedAt: 55_240,
			finishedAt: 55_240,
			title: "retry history agent",
			error: "Temporary provider failure",
			events: [
				{
					sequence: 1,
					timestamp: 1,
					kind: "retry",
					retryAttempt: 1,
					maxRetries: 5,
					delayMs: 5_000,
					cumulativeDelayMs: 5_000,
				},
				{
					sequence: 2,
					timestamp: 2,
					kind: "retry",
					retryAttempt: 5,
					maxRetries: 5,
					delayMs: 17_000,
					cumulativeDelayMs: 55_000,
				},
			],
		})
		render(<TaskActivityPanel filters={{ status: "all", kind: "subagent" }} taskId="task-1" />)
		const item = screen
			.getAllByTestId("activity-item")
			.find((candidate) => candidate.textContent?.includes("retry history agent"))
		expect(item).toBeDefined()
		const scopedItem = item as HTMLElement
		fireEvent.click(within(scopedItem).getByTestId("activity-toggle"))

		const retries = within(scopedItem).getByTestId("subagent-retry-timeline")
		expect(retries).toHaveTextContent("Automatic retries (2)")
		expect(retries).toHaveTextContent("Retry 1/5")
		expect(retries).toHaveTextContent("wait 5s")
		expect(retries).toHaveTextContent("total 5s")
		expect(retries).toHaveTextContent("Retry 5/5")
		expect(retries).toHaveTextContent("wait 17s")
		expect(retries).toHaveTextContent("total 55s")
		expect(within(scopedItem).getByTestId("subagent-activity-body")).toHaveTextContent("Temporary provider failure")
	})

	it("renders recovered activities as interrupted without a spinner or cancellation action", () => {
		render(<TaskActivityPanel taskId="task-1" />)
		fireEvent.click(screen.getAllByRole("button", { name: "All" })[0])

		const interrupted = screen.getAllByTestId("activity-item").find((item) => item.textContent?.includes("stale command"))
		expect(interrupted).toBeDefined()
		expect(interrupted).toHaveTextContent("interrupted")
		expect(interrupted?.querySelector(".animate-spin")).toBeNull()
		expect(within(interrupted as HTMLElement).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
	})

	it("renders a skipped command with the neutral stopped icon", () => {
		render(<TaskActivityPanel taskId="task-1" />)
		fireEvent.click(screen.getAllByRole("button", { name: "All" })[0])

		const skipped = screen.getAllByTestId("activity-item").find((item) => item.textContent?.includes("skipped command"))
		expect(skipped).toBeDefined()
		expect(skipped?.querySelector(".lucide-circle-slash")).not.toBeNull()
		expect(skipped?.querySelector(".lucide-circle-x")).toBeNull()
		expect(within(skipped as HTMLElement).queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
	})

	it("opens a background command log from the active activity", () => {
		render(<TaskActivityPanel taskId="task-1" />)

		const item = screen.getByTestId("activity-item")
		fireEvent.click(within(item).getByRole("button", { name: /new command/i }))
		expect(within(item).queryByTestId("activity-output-summary")).not.toBeInTheDocument()
		fireEvent.click(within(item).getByRole("button", { name: "Open log file activity.log" }))

		expect(FileServiceClient.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: "C:\\Temp\\activity.log" }))
	})

	it("renders ANSI and control characters with the output log after command output", () => {
		render(<TaskActivityPanel taskId="task-1" />)

		const item = screen.getByTestId("activity-item")
		fireEvent.click(within(item).getByRole("button", { name: /new command/i }))

		const ansiText = within(item).getByText("failed")
		const output = ansiText.closest("pre")
		const logButton = within(item).getByRole("button", { name: "Open log file activity.log" })
		const activityBody = within(item).getByTestId("activity-body")
		const commandLine = within(item).getByTestId("activity-command-line")
		const commandOutput = within(item).getByTestId("activity-command-output")
		const logRow = within(item).getByTestId("activity-log-row")
		expect(ansiText.getAttribute("style")).toContain("color")
		expect(item.textContent).toContain("→   column⌫")
		expect(item.textContent).not.toContain("\x1b")
		expect(commandOutput).not.toHaveTextContent("(base)")
		expect(activityBody).toHaveClass("border-editor-widget-border/25")
		expect(activityBody).not.toHaveClass("max-h-[60vh]", "overflow-y-auto")
		expect(commandLine).toHaveClass("bg-code", "max-h-[72px]", "overflow-y-auto")
		expect(commandLine).toHaveTextContent("npm run test:run -- src/example.test.ts")
		expect(commandOutput).toHaveClass("border-editor-widget-border/25", "rounded-none")
		expect(commandOutput).not.toHaveClass("border-editor-group-border", "rounded-sm")
		expect(within(commandOutput).getByTestId("command-output-scroll")).toHaveClass("overflow-auto")
		expect(logRow).toHaveClass("border-editor-widget-border/25", "bg-toolbar-hover/20")
		expect(output).not.toBeNull()
		expect(commandLine.compareDocumentPosition(commandOutput) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect((output as HTMLElement).compareDocumentPosition(logButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
	})

	it("copies the full command from a command activity", async () => {
		render(<TaskActivityPanel taskId="task-1" />)

		fireEvent.click(screen.getByRole("button", { name: "Copy command" }))

		await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith("npm run test:run -- src/example.test.ts"))
	})

	it("renders command output once without a synthetic event timeline or token metrics", () => {
		render(<TaskActivityPanel taskId="task-1" />)

		const item = screen.getByTestId("activity-item")
		fireEvent.click(within(item).getByRole("button", { name: /new command/i }))

		expect(item.textContent?.match(/actual stdout/g)).toHaveLength(1)
		expect(within(item).queryByTestId("activity-timeline")).not.toBeInTheDocument()
		expect(item).not.toHaveTextContent(/\d+ tools/)
		expect(item).not.toHaveTextContent(/\d+ tokens/)
	})

	it("renders one expandable tool step and filters internal activity events", () => {
		render(<TaskActivityPanel taskId="task-1" />)
		fireEvent.click(screen.getAllByRole("button", { name: "All" })[0])
		const oldAgent = screen.getAllByTestId("activity-item").find((item) => item.textContent?.includes("old agent"))
		expect(oldAgent).toBeDefined()
		fireEvent.click(within(oldAgent as HTMLElement).getByRole("button", { name: /old agent/i }))

		const scopedOldAgent = oldAgent as HTMLElement
		const timeline = within(scopedOldAgent).getByTestId("subagent-tool-timeline")
		expect(within(timeline).getAllByTestId("subagent-tool-step")).toHaveLength(1)
		expect(within(timeline).getByTestId("subagent-tool-step-name")).toHaveTextContent("read_file")
		expect(within(timeline).getByTestId("subagent-tool-step-summary")).toHaveTextContent("read executor")
		expect(within(scopedOldAgent).queryByTestId("activity-event")).not.toBeInTheDocument()
		expect(scopedOldAgent).not.toHaveTextContent("Thinking")
		expect(scopedOldAgent).not.toHaveTextContent("Assistant")
		const metrics = within(scopedOldAgent).getByTestId("subagent-metrics")
		expect(metrics).toHaveTextContent("1 tool")
		expect(metrics).toHaveTextContent("5s")
		expect(metrics).toHaveTextContent("In:10")
		expect(metrics).toHaveTextContent("Out:5")
		expect(metrics).toHaveTextContent("$0.01")
		expect(within(scopedOldAgent).queryByTestId("subagent-tool-step-details")).not.toBeInTheDocument()

		fireEvent.click(within(timeline).getByRole("button"))
		expect(within(scopedOldAgent).getByTestId("subagent-tool-step-details")).toHaveTextContent("executor content")
	})

	it("shows Task and Context while isolating Activities tools and metrics to the current attempt", () => {
		extraActivities.push({
			activityId: "attempt-aware-agent",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "background",
			status: "failed",
			createdAt: 300,
			updatedAt: 400,
			finishedAt: 400,
			title: "attempt aware agent",
			detail: "<task>\n  Review retry recovery\n</task>\n<context>\n    Preserve current-attempt isolation\n</context>",
			currentAttempt: 2,
			retryUnavailableReason: "Retry unavailable: subagent 'reviewer' is no longer enabled.",
			metrics: { toolCalls: 99, inputTokens: 1_000, outputTokens: 100, totalCost: 0.01, currency: "USD" },
			events: [
				{ sequence: 1, timestamp: 1, attempt: 1, kind: "tool_call", toolCallId: "old", toolName: "old_tool" },
				{
					sequence: 2,
					timestamp: 2,
					attempt: 2,
					kind: "tool_call",
					toolCallId: "current",
					toolName: "current_tool",
					toolStatus: "completed",
				},
			],
		})

		render(<TaskActivityPanel filters={{ status: "all", kind: "subagent" }} taskId="task-1" />)
		const item = screen
			.getAllByTestId("activity-item")
			.find((candidate) => candidate.textContent?.includes("attempt aware agent"))
		expect(item).toBeDefined()
		const scopedItem = item as HTMLElement
		expect(within(scopedItem).getByTestId("subagent-metrics")).toHaveTextContent("1 tool")
		fireEvent.click(within(scopedItem).getByTestId("activity-toggle"))

		expect(within(scopedItem).getByTestId("subagent-activity-task")).toHaveTextContent("Review retry recovery")
		expect(within(scopedItem).getByTestId("subagent-activity-context")).toHaveTextContent(
			"Preserve current-attempt isolation",
		)
		expect(within(scopedItem).queryByText(/<task>|<context>/)).not.toBeInTheDocument()
		expect(within(scopedItem).getByTestId("subagent-retry-unavailable-reason")).toHaveTextContent("no longer enabled")
		expect(within(scopedItem).queryByText("old_tool")).not.toBeInTheDocument()
		expect(within(scopedItem).getByText("current_tool")).toBeInTheDocument()
	})

	it("uses the same runtime configuration and cache metric projection as the chat card", () => {
		extraActivities.push({
			activityId: "runtime-agent",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "background",
			status: "completed",
			createdAt: 300,
			updatedAt: 400,
			finishedAt: 400,
			title: "runtime agent",
			runtime: {
				profileName: "review-profile",
				providerId: "anthropic",
				modelId: "claude-sonnet-4-6",
				apiFormat: "anthropic_chat",
				thinkingBudgetTokens: 8_000,
			},
			metrics: {
				toolCalls: 2,
				inputTokens: 1_000,
				outputTokens: 100,
				cacheWriteTokens: 1_000,
				cacheReadTokens: 8_000,
				cacheHitRate: 80,
				totalCost: 0.01,
				currency: "CNY",
			},
			events: [],
		})

		render(<TaskActivityPanel taskId="task-1" />)
		fireEvent.click(screen.getAllByRole("button", { name: "All" })[0])
		const runtimeAgent = screen.getAllByTestId("activity-item").find((item) => item.textContent?.includes("runtime agent"))
		expect(runtimeAgent).toBeDefined()
		const runtime = within(runtimeAgent as HTMLElement).getByTestId("subagent-runtime-config")
		expect(runtime).toHaveTextContent("review-profile")
		expect(runtime).toHaveTextContent("anthropic")
		expect(runtime).toHaveTextContent("claude-sonnet-4-6")
		expect(runtime).toHaveTextContent("anthropic_chat")
		expect(runtime).toHaveTextContent("8,000 tokens")
		const metrics = within(runtimeAgent as HTMLElement).getByTestId("subagent-metrics")
		expect(metrics).toHaveTextContent("Cache:80%")
		expect(metrics).toHaveTextContent("¥0.01")
		expect(metrics).not.toHaveTextContent("CN")
	})

	it("shows all activities and filters the vertical list by type", () => {
		render(<TaskActivityPanel taskId="task-1" />)
		fireEvent.click(screen.getAllByRole("button", { name: "All" })[0])

		let items = screen.getAllByTestId("activity-item")
		expect(items.map((item) => item.textContent)).toEqual([
			expect.stringContaining("new command"),
			expect.stringContaining("stale command"),
			expect.stringContaining("skipped command"),
			expect.stringContaining("old agent"),
		])

		fireEvent.click(screen.getByRole("button", { name: "Subagents" }))
		items = screen.getAllByTestId("activity-item")
		expect(items).toHaveLength(1)
		expect(within(items[0]).getByText("old agent")).toBeInTheDocument()
	})
})
