// @vitest-environment jsdom

import type { ClineMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import SubagentStatusRow from "./SubagentStatusRow"

class TestResizeObserver implements ResizeObserver {
	disconnect = vi.fn()
	observe = vi.fn()
	unobserve = vi.fn()
}

globalThis.ResizeObserver = TestResizeObserver

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({ currentTaskItem: { id: "task-1" } }),
}))

const { cancelTaskActivities, finishTaskActivities, retryTaskActivities, taskActivities } = vi.hoisted(() => ({
	cancelTaskActivities: vi.fn(),
	finishTaskActivities: vi.fn(),
	retryTaskActivities: vi.fn(),
	taskActivities: [] as Array<Record<string, unknown>>,
}))

vi.mock("./activity/useTaskActivities", () => ({
	cancelTaskActivities: (...args: unknown[]) => cancelTaskActivities(...args),
	finishTaskActivities: (...args: unknown[]) => finishTaskActivities(...args),
	retryTaskActivities: (...args: unknown[]) => retryTaskActivities(...args),
	useTaskActivities: () => ({
		activities: taskActivities,
		activeCount: taskActivities.length,
		getById: (activityId: string) => taskActivities.find((activity) => activity.activityId === activityId),
	}),
}))

vi.mock("../common/MarkdownBlock", () => ({
	default: ({ markdown }: { markdown: string }) => <div>{markdown}</div>,
}))

function makeMsg(overrides: Partial<ClineMessage> = {}): ClineMessage {
	return {
		ts: Date.now(),
		type: "say",
		say: "use_subagents",
		text: JSON.stringify({ prompts: ["do something"] }),
		...overrides,
	}
}

describe("SubagentStatusRow", () => {
	beforeEach(() => {
		cancelTaskActivities.mockClear()
		finishTaskActivities.mockClear()
		retryTaskActivities.mockClear()
		taskActivities.length = 0
	})

	it("renders disabled error as failed", () => {
		const msg = makeMsg({
			text: JSON.stringify({
				prompts: [],
				error: "subagentsDisabled",
				message: "Subagents are disabled. Enable them in Settings.",
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)

		expect(screen.getByText(/Subagents are disabled/)).toBeInTheDocument()
	})

	it("renders tooManyPrompts error as failed", () => {
		const msg = makeMsg({
			text: JSON.stringify({
				prompts: ["1", "2", "3", "4", "5"],
				error: "tooManyPrompts",
				message: "Too many subagent prompts provided (6). Maximum is 5.",
				count: 6,
				max: 5,
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)

		expect(screen.getByText(/Too many subagent prompts/)).toBeInTheDocument()
	})

	it("renders normal prompts as pending", () => {
		const msg = makeMsg({
			ask: "use_subagents",
			type: "ask",
			say: undefined,
			text: JSON.stringify({ prompts: ["do something"] }),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)

		expect(screen.getByTestId("subagent-list-scroll")).toHaveClass("max-h-[60vh]", "overflow-y-auto", "overscroll-x-contain")
		expect(screen.getByText(/do something/)).toBeInTheDocument()
	})

	it("renders backend-rejected batch items alongside the runnable ones", () => {
		const msg = makeMsg({
			ask: "use_subagents",
			type: "ask",
			say: undefined,
			text: JSON.stringify({
				prompts: ["run the reviewer"],
				rejected: [{ index: 2, error: "API Profile 'retired-profile' is not enabled." }],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)

		// Both the runnable item and the refused one must be visible: approving a
		// batch whose refused members are hidden would misrepresent its scope.
		expect(screen.getByText(/run the reviewer/)).toBeInTheDocument()
		expect(screen.getByText(/API Profile 'retired-profile' is not enabled\./)).toBeInTheDocument()
	})

	it("keeps a rejected item visible when every requested subagent was refused", () => {
		const msg = makeMsg({
			ask: "use_subagents",
			type: "ask",
			say: undefined,
			text: JSON.stringify({
				prompts: ["still-runnable placeholder"],
				rejected: [
					{ index: 1, error: "Subagent 'missing-agent' was not found." },
					{ index: 2, error: "API Profile 'retired-profile' is not enabled." },
				],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)

		expect(screen.getByText(/Subagent 'missing-agent' was not found\./)).toBeInTheDocument()
		expect(screen.getByText(/API Profile 'retired-profile' is not enabled\./)).toBeInTheDocument()
	})

	it("orders a mixed batch by the requested position, not the compacted array", () => {
		// Item 1 was refused, so the runnable array holds only item 2. Ordering
		// that survivor by its array offset would give it position 1 as well:
		// the rows would then collide on one index and the refused item would be
		// listed after the item the model actually requested second.
		const msg = makeMsg({
			ask: "use_subagents",
			type: "ask",
			say: undefined,
			text: JSON.stringify({
				kind: "batch",
				prompts: ["run the second item"],
				items: [{ index: 2, task: "second", context: "ctx" }],
				rejected: [{ index: 1, error: "Subagent 'missing-agent' was not found." }],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)

		const rows = screen.getAllByTestId("subagent-item")
		expect(rows).toHaveLength(2)
		expect(rows[0].textContent).toContain("Subagent 'missing-agent' was not found.")
		expect(rows[1].textContent).not.toContain("Subagent 'missing-agent' was not found.")
	})

	it("uses canonical live activity to keep cancellation available after resume", () => {
		taskActivities.push({
			activityId: "job-1",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "background",
			status: "running",
			cancellable: true,
			createdAt: 1,
			updatedAt: 1,
			title: "reviewer",
		})
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "running",
				items: [
					{
						index: 1,
						jobId: "job-1",
						prompt: "review",
						status: "running",
						toolCalls: 0,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						currency: "USD",
						contextTokens: 0,
						contextWindow: 0,
						contextUsagePercentage: 0,
					},
				],
			}),
		})

		render(
			<SubagentStatusRow
				isLast={false}
				lastModifiedMessage={{ ts: msg.ts + 1, type: "ask", ask: "resume_task" }}
				message={msg}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(cancelTaskActivities).toHaveBeenCalledWith("task-1", ["job-1"])
	})

	it("uses canonical Finish and Retry capabilities for exact subagent activities", async () => {
		taskActivities.push(
			{
				activityId: "job-finish",
				taskId: "task-1",
				kind: "subagent",
				executionMode: "background",
				status: "running",
				cancellable: true,
				finishable: true,
				retryable: false,
				createdAt: 1,
				updatedAt: 1,
				title: "running reviewer",
			},
			{
				activityId: "job-retry",
				taskId: "task-1",
				kind: "subagent",
				executionMode: "background",
				status: "failed",
				cancellable: false,
				finishable: false,
				retryable: true,
				createdAt: 2,
				updatedAt: 2,
				title: "failed reviewer",
			},
		)
		const items = [
			{ index: 1, jobId: "job-finish", prompt: "finish", status: "running" },
			{ index: 2, jobId: "job-retry", prompt: "retry", status: "failed" },
		].map((item) => ({
			...item,
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			currency: "USD",
			contextTokens: 0,
			contextWindow: 0,
			contextUsagePercentage: 0,
		}))
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({ status: "running", items }),
		})

		let resolveFinish!: () => void
		let resolveRetry!: () => void
		finishTaskActivities.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveFinish = resolve)))
		retryTaskActivities.mockImplementationOnce(() => new Promise<void>((resolve) => (resolveRetry = resolve)))
		render(<SubagentStatusRow isLast={true} message={msg} />)
		const finishButton = screen.getByRole("button", { name: "Finish" })
		const retryButton = screen.getByRole("button", { name: "Retry" })
		expect(finishButton).toHaveClass("border-button-background", "hover:border-button-hover")
		fireEvent.click(finishButton)
		fireEvent.click(finishButton)
		fireEvent.click(retryButton)
		fireEvent.click(retryButton)

		expect(finishTaskActivities).toHaveBeenCalledTimes(1)
		expect(finishTaskActivities).toHaveBeenCalledWith("task-1", ["job-finish"])
		expect(retryTaskActivities).toHaveBeenCalledTimes(1)
		expect(retryTaskActivities).toHaveBeenCalledWith("task-1", ["job-retry"])
		expect(finishButton).toBeDisabled()
		expect(retryButton).toBeDisabled()
		resolveFinish()
		resolveRetry()
		await waitFor(() => {
			expect(finishButton).not.toBeDisabled()
			expect(retryButton).not.toBeDisabled()
		})
	})

	it("hides cancellation for a running activity without a live canceller", () => {
		taskActivities.push({
			activityId: "job-stale",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "background",
			status: "running",
			cancellable: false,
			createdAt: 1,
			updatedAt: 1,
			title: "stale reviewer",
		})
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "running",
				items: [
					{
						index: 1,
						jobId: "job-stale",
						prompt: "review",
						status: "running",
						toolCalls: 0,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						currency: "USD",
						contextTokens: 0,
						contextWindow: 0,
						contextUsagePercentage: 0,
					},
				],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)

		expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument()
	})

	it("shows the cancelled terminal state for a background subagent", () => {
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "cancelled",
				items: [
					{
						index: 1,
						jobId: "job-cancelled",
						prompt: "review",
						status: "cancelled",
						background: true,
						error: "Subagent run cancelled.",
						toolCalls: 0,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						currency: "USD",
						contextTokens: 0,
						contextWindow: 0,
						contextUsagePercentage: 0,
					},
				],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)

		expect(screen.getByText("Cancelled", { exact: true })).toBeInTheDocument()
		expect(screen.queryByText("Running in background", { exact: true })).not.toBeInTheDocument()
	})

	it("keeps Continue in Background out of the subagent card and aligns its mode and Cancel with the command header", () => {
		taskActivities.push({
			activityId: "job-foreground",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "foreground",
			status: "running",
			cancellable: true,
			createdAt: 1,
			updatedAt: 1,
			title: "reviewer",
		})
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "running",
				items: [
					{
						index: 1,
						jobId: "job-foreground",
						prompt: "review",
						status: "running",
						background: false,
						backgroundHandoffAvailable: true,
						toolCalls: 0,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						currency: "USD",
						contextTokens: 0,
						contextWindow: 0,
						contextUsagePercentage: 0,
					},
				],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)
		const item = screen.getByTestId("subagent-item")
		const header = screen.getByTestId("subagent-item-header")
		const mode = screen.getByTestId("subagent-execution-mode")
		const cancel = screen.getByRole("button", { name: "Cancel" })

		expect(screen.queryByRole("button", { name: "Continue in Background" })).not.toBeInTheDocument()
		expect(header).toContainElement(screen.getByTestId("subagent-name"))
		expect(header).toContainElement(mode)
		expect(header).toContainElement(cancel)
		expect(mode).toHaveTextContent("Foreground")
		expect(mode).toHaveClass("min-w-[88px]", "text-[11px]", "py-0.5")
		expect(cancel).toHaveClass("h-5")
		expect(item).not.toHaveTextContent("Moving...")
		fireEvent.click(cancel)
		expect(cancelTaskActivities).toHaveBeenCalledWith("task-1", ["job-foreground"])
	})

	it("cancels only canonical cancellable activities in a batch", () => {
		taskActivities.push(
			{
				activityId: "job-1",
				taskId: "task-1",
				kind: "subagent",
				executionMode: "background",
				status: "running",
				cancellable: true,
				createdAt: 1,
				updatedAt: 1,
				title: "reviewer 1",
			},
			{
				activityId: "job-2",
				taskId: "task-1",
				kind: "subagent",
				executionMode: "background",
				status: "running",
				cancellable: false,
				createdAt: 2,
				updatedAt: 2,
				title: "reviewer 2",
			},
			{
				activityId: "job-3",
				taskId: "task-1",
				kind: "subagent",
				executionMode: "background",
				status: "running",
				cancellable: true,
				createdAt: 3,
				updatedAt: 3,
				title: "reviewer 3",
			},
		)
		const items = ["job-1", "job-2", "job-3"].map((jobId, index) => ({
			index: index + 1,
			jobId,
			prompt: `review ${index + 1}`,
			status: "running",
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			currency: "USD",
			contextTokens: 0,
			contextWindow: 0,
			contextUsagePercentage: 0,
		}))
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({ status: "running", items }),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)
		expect(screen.getByRole("button", { name: "Cancel all" })).toHaveClass("h-5")
		fireEvent.click(screen.getByRole("button", { name: "Cancel all" }))

		const cancelButtons = screen.getAllByRole("button", { name: "Cancel" })
		expect(cancelButtons).toHaveLength(2)
		for (const button of cancelButtons) expect(button).toHaveClass("h-5")
		expect(cancelTaskActivities).toHaveBeenCalledWith("task-1", ["job-1", "job-3"])
	})

	it("shows structured context as a single-line trigger with the full text in an unmasked popover", () => {
		const jobId = "subagent_batch_fg_call_AvllKHRBjVSaDfW6gFJJVvhL_1"
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "running",
				items: [
					{
						index: 1,
						jobId,
						prompt: "<task>review code</task><context>focus on cancellation</context>",
						subagentName: "reviewer",
						task: "review code",
						context: "focus on cancellation\nthen verify cleanup",
						status: "running",
						toolCalls: 0,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						currency: "USD",
						contextTokens: 0,
						contextWindow: 0,
						contextUsagePercentage: 0,
					},
				],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)

		const item = screen.getByTestId("subagent-item")
		const name = screen.getByTestId("subagent-name")
		const task = screen.getByRole("heading", { name: "review code" })
		const taskScroll = screen.getByTestId("subagent-task-scroll")
		const context = screen.getByRole("button", { name: "Show full subagent context" })
		const contextContent = screen.getByTestId("subagent-context-content")
		expect(name).toHaveTextContent("reviewer")
		expect(screen.getAllByText("reviewer")).toHaveLength(1)
		expect(taskScroll).toHaveClass("overflow-x-hidden", "min-h-0", "flex-1", "overflow-y-auto")
		expect(taskScroll).toContainElement(task)
		expect(task).toHaveClass("whitespace-pre-wrap", "break-words", "[overflow-wrap:anywhere]")
		expect(context).toHaveClass("w-full", "min-w-0", "max-w-full", "overflow-hidden")
		expect(context).not.toHaveClass("h-5")
		expect(context).toHaveTextContent("Context")
		expect(contextContent).toHaveClass("min-w-0", "flex-1", "truncate", "whitespace-nowrap")
		expect(contextContent).not.toHaveClass("whitespace-pre-wrap", "break-words")
		expect(context).not.toHaveAttribute("title")
		expect(contextContent).not.toHaveAttribute("title")
		expect(screen.queryByTestId("subagent-context-popover")).not.toBeInTheDocument()

		fireEvent.click(context)

		const contextPopover = screen.getByTestId("subagent-context-popover")
		const fullContext = within(contextPopover).getByTestId("subagent-context-popover-content")
		expect(contextPopover).toHaveAttribute("data-slot", "popover-content")
		expect(contextPopover).toHaveClass("w-(--radix-popover-trigger-width)")
		expect(contextPopover).not.toHaveClass("w-[min(80vw,500px)]")
		expect(document.querySelector(".fixed.inset-0")).toBeNull()
		expect(fullContext).toHaveClass("whitespace-pre-wrap", "break-words", "[overflow-wrap:anywhere]")
		expect(fullContext.textContent).toBe("focus on cancellation\nthen verify cleanup")
		expect(screen.getByTestId("subagent-execution-mode")).toHaveTextContent("Foreground")
		expect(item).not.toHaveTextContent("#1")
		expect(item).not.toHaveTextContent(/\d+ tools called/)
		expect(item).not.toHaveTextContent(jobId)
		expect(item.parentElement).toHaveClass("max-h-[60vh]", "overflow-y-auto", "overscroll-x-contain")
		expect(screen.queryByText(/<task>/)).not.toBeInTheDocument()
		expect(screen.queryByText(/<context>/)).not.toBeInTheDocument()
	})

	it("ignores a raw latest-tool fallback until structured activity events arrive", () => {
		const activity: Record<string, unknown> = {
			activityId: "job-delayed-tools",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "foreground",
			status: "running",
			cancellable: false,
			createdAt: 1,
			updatedAt: 2,
			title: "reviewer",
			latestEvent: "read_file(path=README.md)",
		}
		taskActivities.push(activity)
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "running",
				items: [
					{
						index: 1,
						jobId: "job-delayed-tools",
						prompt: "review",
						status: "running",
						latestToolCall: "read_file(path=README.md)",
						toolCalls: 2,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						currency: "USD",
						contextTokens: 0,
						contextWindow: 0,
						contextUsagePercentage: 0,
					},
				],
			}),
		})

		const { rerender } = render(<SubagentStatusRow isLast={true} message={msg} />)
		expect(screen.queryByText("read_file(path=README.md)")).not.toBeInTheDocument()
		expect(screen.queryAllByTestId("subagent-tool-step")).toHaveLength(0)

		activity.latestEvent = "list_files(path=.)"
		activity.events = [
			{
				sequence: 1,
				timestamp: 1,
				kind: "tool_call",
				toolCallId: "first",
				toolName: "read_file",
				toolStatus: "completed",
				summary: "read_file(path=README.md)",
			},
			{
				sequence: 2,
				timestamp: 2,
				kind: "tool_call",
				toolCallId: "second",
				toolName: "list_files",
				toolStatus: "completed",
				summary: "list_files(path=.)",
			},
		]
		rerender(<SubagentStatusRow isLast={true} message={msg} />)

		const toolSteps = screen.getAllByTestId("subagent-tool-step")
		expect(toolSteps).toHaveLength(2)
		expect(toolSteps.map((step) => within(step).getByTestId("subagent-tool-step-name").textContent)).toEqual([
			"read_file",
			"list_files",
		])
		expect(toolSteps.map((step) => within(step).getByTestId("subagent-tool-step-summary").textContent)).toEqual([
			"(path=README.md)",
			"(path=.)",
		])
	})

	it("renders each activity tool call once in execution order", () => {
		taskActivities.push({
			activityId: "job-tools",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "foreground",
			status: "completed",
			cancellable: false,
			createdAt: 1,
			updatedAt: 2,
			title: "reviewer",
			events: [
				{
					sequence: 4,
					timestamp: 4,
					kind: "tool_call",
					toolCallId: "second",
					toolName: "list_files",
					toolStatus: "completed",
					summary: "list_files(path=.)",
				},
				{
					sequence: 1,
					timestamp: 1,
					kind: "tool_call",
					toolCallId: "first",
					toolName: "read_file",
					toolStatus: "started",
					summary: "read_file(path=README.md)",
				},
				{
					sequence: 3,
					timestamp: 3,
					kind: "tool_call",
					toolCallId: "first",
					toolName: "read_file",
					toolStatus: "completed",
					summary: "read_file(path=README.md)",
				},
			],
		})
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "completed",
				items: [
					{
						index: 1,
						jobId: "job-tools",
						prompt: "review",
						status: "completed",
						toolCalls: 2,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						currency: "USD",
						contextTokens: 0,
						contextWindow: 0,
						contextUsagePercentage: 0,
					},
				],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)

		const toolSteps = screen.getAllByTestId("subagent-tool-step")
		expect(toolSteps).toHaveLength(2)
		expect(toolSteps.map((step) => within(step).getByTestId("subagent-tool-step-name").textContent)).toEqual([
			"read_file",
			"list_files",
		])
		expect(screen.getByRole("button", { name: "Collapse subagent tools" })).toHaveTextContent("Tools (2)")
	})

	it("renders Tools before Show output and keeps expanded output after the control", () => {
		taskActivities.push({
			activityId: "job-output-order",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "foreground",
			status: "completed",
			cancellable: false,
			createdAt: 1,
			updatedAt: 2,
			title: "reviewer",
			events: [
				{
					sequence: 1,
					timestamp: 1,
					kind: "tool_call",
					toolCallId: "read",
					toolName: "read_file",
					toolStatus: "completed",
					summary: "read_file(path=README.md)",
				},
			],
			result: "ordered result",
		})
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "completed",
				items: [
					{
						index: 1,
						jobId: "job-output-order",
						prompt: "review",
						status: "completed",
						result: "ordered result",
						toolCalls: 1,
						inputTokens: 10,
						outputTokens: 5,
						totalCost: 0,
						currency: "USD",
						contextTokens: 15,
						contextWindow: 200000,
						contextUsagePercentage: 0.01,
					},
				],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)
		const item = screen.getByTestId("subagent-item")
		const tools = screen.getByRole("button", { name: "Collapse subagent tools" })
		const toggle = screen.getByRole("button", { name: "Show subagent output" })

		expect(tools.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
		fireEvent.click(toggle)
		const output = screen.getByTestId("subagent-output")
		expect(toggle.compareDocumentPosition(output) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
		expect(item).toContainElement(output)
	})

	it("keeps Work tool results out of the DOM while showing compact execution metrics", () => {
		taskActivities.push({
			activityId: "job-work-summary",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "foreground",
			status: "completed",
			cancellable: false,
			createdAt: 1_000,
			updatedAt: 66_000,
			finishedAt: 66_000,
			title: "reviewer",
			metrics: { toolCalls: 1, inputTokens: 1_250, outputTokens: 2_000, totalCost: 0.01, currency: "USD" },
			events: [
				{
					sequence: 1,
					timestamp: 1_010,
					kind: "tool_call",
					toolCallId: "read",
					toolName: "read_file",
					toolStatus: "completed",
					summary: "read_file(path=README.md)",
					durationMs: 25,
				},
				{
					sequence: 2,
					timestamp: 1_035,
					kind: "tool_result",
					toolCallId: "read",
					toolName: "read_file",
					text: "hidden Work result",
				},
			],
		})
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "completed",
				items: [
					{
						index: 1,
						jobId: "job-work-summary",
						prompt: "review",
						subagentName: "reviewer",
						status: "completed",
						toolCalls: 0,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						currency: "USD",
						contextTokens: 0,
						contextWindow: 0,
						contextUsagePercentage: 0,
					},
				],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)
		const item = screen.getByTestId("subagent-item")
		const metrics = within(item).getByTestId("subagent-metrics")
		expect(metrics).toHaveClass("basis-full", "pl-8")
		expect(within(item).getByTestId("subagent-item-header")).toContainElement(metrics)
		expect(metrics).toHaveTextContent("1 tool")
		expect(metrics).toHaveTextContent("1:05")
		expect(metrics).toHaveTextContent("In:1.3K")
		expect(metrics).toHaveTextContent("Out:2.0K")
		expect(metrics).toHaveTextContent("$0.01")

		const toolStep = within(item).getByTestId("subagent-tool-step")
		const toolButton = within(toolStep).getByRole("button")
		expect(toolButton).not.toHaveAttribute("aria-expanded")
		expect(toolStep.querySelector(".lucide-chevron-right")).toBeNull()
		expect(toolStep.querySelector(".lucide-chevron-down")).toBeNull()
		expect(within(item).queryByText("hidden Work result")).not.toBeInTheDocument()
		fireEvent.click(toolButton)
		expect(within(item).queryByTestId("subagent-tool-step-details")).not.toBeInTheDocument()
		expect(within(item).queryByText("hidden Work result")).not.toBeInTheDocument()
	})

	it("renders canonical runtime configuration, cache rate, and symbol-only cost from the live activity", () => {
		taskActivities.push({
			activityId: "job-runtime-details",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "foreground",
			status: "completed",
			cancellable: false,
			createdAt: 1_000,
			updatedAt: 2_000,
			finishedAt: 2_000,
			title: "reviewer",
			runtime: {
				profileName: "review-profile",
				providerId: "openai",
				modelId: "gpt-5.4",
				apiFormat: "openai_responses",
				reasoningEffort: "high",
			},
			metrics: {
				toolCalls: 1,
				inputTokens: 1_000,
				outputTokens: 200,
				cacheWriteTokens: 500,
				cacheReadTokens: 8_500,
				cacheHitRate: 85,
				totalCost: 0.0123,
				currency: "CNY",
			},
			events: [],
		})
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "completed",
				items: [
					{
						index: 1,
						jobId: "job-runtime-details",
						prompt: "review",
						status: "completed",
						toolCalls: 0,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						currency: "USD",
						contextTokens: 0,
						contextWindow: 0,
						contextUsagePercentage: 0,
					},
				],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)

		const item = screen.getByTestId("subagent-item")
		const runtime = within(item).getByTestId("subagent-runtime-config")
		expect(runtime).toHaveTextContent("review-profile")
		expect(runtime).toHaveTextContent("openai")
		expect(runtime).toHaveTextContent("gpt-5.4")
		expect(runtime).toHaveTextContent("openai_responses")
		expect(runtime).toHaveTextContent("high")
		const metrics = within(item).getByTestId("subagent-metrics")
		expect(metrics).toHaveTextContent("Cache:85%")
		expect(metrics).toHaveTextContent("¥0.01")
		expect(metrics).not.toHaveTextContent("CN")
	})

	it("keeps Task, Tools, and Output content-sized within the bounded Work card", () => {
		taskActivities.push({
			activityId: "job-section-layout",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "foreground",
			status: "failed",
			cancellable: false,
			finishable: false,
			retryable: true,
			createdAt: 1_000,
			updatedAt: 56_000,
			finishedAt: 56_000,
			title: "retry reviewer",
			error: "Temporary provider failure",
			events: [
				{
					sequence: 1,
					timestamp: 1_010,
					kind: "tool_call",
					toolCallId: "read",
					toolName: "read_file",
					toolStatus: "completed",
					summary: "read_file(path=README.md)",
				},
				...[
					[1, 5_000, 5_000],
					[2, 8_000, 13_000],
					[3, 11_000, 24_000],
					[4, 14_000, 38_000],
					[5, 17_000, 55_000],
				].map(([retryAttempt, delayMs, cumulativeDelayMs], index) => ({
					sequence: index + 2,
					timestamp: 2_000 + index,
					kind: "retry",
					retryAttempt,
					maxRetries: 5,
					delayMs,
					cumulativeDelayMs,
				})),
			],
		})
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "failed",
				items: [
					{
						index: 1,
						jobId: "job-section-layout",
						prompt: "Review the implementation",
						subagentName: "retry reviewer",
						task: "Review the implementation",
						context: "Preserve the nested indentation.\n  Inspect the retry path.",
						status: "failed",
						error: "Temporary provider failure",
						toolCalls: 1,
						inputTokens: 0,
						outputTokens: 0,
						totalCost: 0,
						currency: "USD",
						contextTokens: 0,
						contextWindow: 200000,
						contextUsagePercentage: 0,
					},
				],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)
		const item = screen.getByTestId("subagent-item")
		const body = within(item).getByTestId("subagent-item-body")
		expect(body).toHaveClass("flex", "min-h-0", "flex-[0_1_auto]", "flex-col", "overflow-hidden")
		expect(body).not.toHaveClass("overflow-y-auto")

		const taskScroll = within(item).getByTestId("subagent-task-scroll")
		const toolsScroll = within(item).getByTestId("subagent-tools-scroll")
		const taskSection = taskScroll.parentElement
		const toolsSection = toolsScroll.parentElement
		expect(item).toHaveClass("max-h-[30vh]")
		expect(item).not.toHaveClass("h-[30vh]")
		expect(taskSection).toHaveClass("flex", "min-h-[24px]", "flex-[0_1_auto]", "overflow-hidden")
		expect(taskSection).not.toHaveClass("basis-0", "shrink-0")
		expect(toolsSection).toHaveClass("flex", "min-h-[24px]", "flex-[0_1_auto]", "overflow-hidden")
		expect(toolsSection).not.toHaveClass("basis-0", "shrink-0")
		expect(taskScroll).toHaveClass("overflow-x-hidden", "min-h-0", "flex-1", "overflow-y-auto")
		expect(toolsScroll).toHaveClass("min-h-0", "overflow-y-auto")
		expect(within(item).queryByTestId("subagent-output-scroll")).not.toBeInTheDocument()

		fireEvent.click(within(item).getByRole("button", { name: "Collapse subagent task" }))
		expect(within(item).queryByTestId("subagent-task-scroll")).not.toBeInTheDocument()
		const singleToolsScroll = within(item).getByTestId("subagent-tools-scroll")
		expect(singleToolsScroll).toBeInTheDocument()
		expect(item).not.toHaveClass("h-[30vh]")
		expect(singleToolsScroll.parentElement).toHaveClass("flex-[0_1_auto]")
		expect(singleToolsScroll.parentElement).not.toHaveClass("basis-0")

		fireEvent.click(within(item).getByRole("button", { name: "Collapse subagent tools" }))
		expect(within(item).queryByTestId("subagent-tools-scroll")).not.toBeInTheDocument()
		fireEvent.click(within(item).getByRole("button", { name: "Expand subagent task" }))
		expect(within(item).getByTestId("subagent-task-scroll")).toBeInTheDocument()

		fireEvent.click(within(item).getByRole("button", { name: "Show subagent output" }))
		const outputScroll = within(item).getByTestId("subagent-output-scroll")
		const restoredTaskSection = within(item).getByTestId("subagent-task-scroll").parentElement
		expect(item).not.toHaveClass("h-[30vh]")
		expect(restoredTaskSection).toHaveClass("flex-[0_1_auto]")
		expect(restoredTaskSection).not.toHaveClass("basis-0", "shrink-0")
		expect(outputScroll.parentElement).toHaveClass("flex-[0_1_auto]")
		expect(outputScroll.parentElement).not.toHaveClass("basis-0", "shrink-0")
		expect(outputScroll).toHaveClass("min-h-0", "overflow-y-auto")
		expect(outputScroll).toHaveTextContent("Automatic retries")
		expect(outputScroll).toHaveTextContent("Retry 1/5")
		expect(outputScroll).toHaveTextContent("wait 5s")
		expect(outputScroll).toHaveTextContent("total 5s")
		expect(outputScroll).toHaveTextContent("Retry 5/5")
		expect(outputScroll).toHaveTextContent("wait 17s")
		expect(outputScroll).toHaveTextContent("total 55s")
		expect(outputScroll).toHaveTextContent("Temporary provider failure")
		expect(within(item).queryByTestId("activity-event")).not.toBeInTheDocument()

		fireEvent.click(within(item).getByRole("button", { name: "Expand subagent tools" }))
		const sharedToolsScroll = within(item).getByTestId("subagent-tools-scroll")
		expect(item).not.toHaveClass("h-[30vh]")
		expect(restoredTaskSection).toHaveClass("flex-[0_1_auto]")
		expect(sharedToolsScroll.parentElement).toHaveClass("flex-[0_1_auto]")
		expect(outputScroll.parentElement).toHaveClass("flex-[0_1_auto]")
		expect(restoredTaskSection).not.toHaveClass("basis-0")
		expect(sharedToolsScroll.parentElement).not.toHaveClass("basis-0")
		expect(outputScroll.parentElement).not.toHaveClass("basis-0")

		fireEvent.click(within(item).getByRole("button", { name: "Hide subagent output" }))
		expect(within(item).queryByTestId("subagent-output-scroll")).not.toBeInTheDocument()
		expect(item).not.toHaveClass("h-[30vh]")
		expect(within(item).getByTestId("subagent-task-scroll")).toBeInTheDocument()
	})

	it("uses the current attempt as the single source for Work tools, retries, metrics, and unavailable reason", () => {
		taskActivities.push({
			activityId: "job-attempt-aware",
			taskId: "task-1",
			kind: "subagent",
			executionMode: "background",
			status: "failed",
			cancellable: false,
			finishable: false,
			retryable: false,
			retryUnavailableReason: "Retry unavailable: subagent 'reviewer' is no longer enabled.",
			currentAttempt: 2,
			createdAt: 1,
			updatedAt: 4,
			finishedAt: 4,
			title: "reviewer",
			metrics: { toolCalls: 99, inputTokens: 10, outputTokens: 5, totalCost: 0, currency: "USD" },
			events: [
				{ sequence: 1, timestamp: 1, attempt: 1, kind: "tool_call", toolCallId: "old", toolName: "old_tool" },
				{
					sequence: 2,
					timestamp: 2,
					attempt: 1,
					kind: "retry",
					retryAttempt: 1,
					maxRetries: 5,
					delayMs: 5_000,
					cumulativeDelayMs: 5_000,
				},
				{
					sequence: 3,
					timestamp: 3,
					attempt: 2,
					kind: "tool_call",
					toolCallId: "current",
					toolName: "current_tool",
					toolStatus: "completed",
				},
				{
					sequence: 4,
					timestamp: 4,
					attempt: 2,
					kind: "retry",
					retryAttempt: 1,
					maxRetries: 2,
					delayMs: 8_000,
					cumulativeDelayMs: 8_000,
				},
			],
		})
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "failed",
				items: [
					{
						index: 1,
						jobId: "job-attempt-aware",
						prompt: "review",
						status: "failed",
						error: "provider failed",
						toolCalls: 99,
						inputTokens: 10,
						outputTokens: 5,
						totalCost: 0,
						currency: "USD",
						contextTokens: 15,
						contextWindow: 200_000,
						contextUsagePercentage: 0.01,
					},
				],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)
		const item = screen.getByTestId("subagent-item")
		expect(within(item).getByTestId("subagent-metrics")).toHaveTextContent("1 tool")
		expect(within(item).getByTestId("subagent-retry-unavailable-reason")).toHaveTextContent("no longer enabled")
		expect(within(item).queryByText("old_tool")).not.toBeInTheDocument()
		expect(within(item).getByText("current_tool")).toBeInTheDocument()

		fireEvent.click(within(item).getByRole("button", { name: "Show subagent output" }))
		const retryTimeline = within(item).getByTestId("subagent-retry-timeline")
		expect(retryTimeline).toHaveTextContent("Automatic retries (1)")
		expect(retryTimeline).toHaveTextContent("Retry 1/2")
		expect(retryTimeline).not.toHaveTextContent("Retry 1/5")
	})

	it("bounds and independently collapses each Work card while keeping controls available", async () => {
		taskActivities.push(
			{
				activityId: "job-runner",
				taskId: "task-1",
				kind: "subagent",
				executionMode: "foreground",
				status: "running",
				cancellable: true,
				finishable: true,
				retryable: false,
				createdAt: 1,
				updatedAt: 1,
				title: "runner",
			},
			{
				activityId: "job-retryer",
				taskId: "task-1",
				kind: "subagent",
				executionMode: "background",
				status: "failed",
				cancellable: false,
				finishable: false,
				retryable: true,
				createdAt: 2,
				updatedAt: 2,
				finishedAt: 2,
				title: "retryer",
			},
		)
		const items = [
			{ index: 1, jobId: "job-runner", prompt: "run task", subagentName: "runner", status: "running" },
			{ index: 2, jobId: "job-retryer", prompt: "retry task", subagentName: "retryer", status: "failed" },
		].map((item) => ({
			...item,
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			totalCost: 0,
			currency: "USD",
			contextTokens: 0,
			contextWindow: 0,
			contextUsagePercentage: 0,
		}))
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({ status: "running", items }),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)
		const cards = screen.getAllByTestId("subagent-item")
		const runner = cards.find((card) => within(card).getByTestId("subagent-name").textContent === "runner")
		const retryer = cards.find((card) => within(card).getByTestId("subagent-name").textContent === "retryer")
		if (!runner || !retryer) throw new Error("Expected runner and retryer Work cards")

		expect(runner).toHaveClass("flex", "max-h-[30vh]", "flex-col", "overflow-hidden")
		expect(within(runner).getByTestId("subagent-item-header")).toHaveClass("shrink-0")
		expect(within(runner).getByTestId("subagent-item-body")).toHaveClass(
			"flex",
			"min-h-0",
			"flex-[0_1_auto]",
			"flex-col",
			"overflow-hidden",
		)
		expect(within(runner).getByTestId("subagent-item-body")).not.toHaveClass("overflow-y-auto")
		expect(within(retryer).getByTestId("subagent-item-body")).toBeInTheDocument()

		fireEvent.click(within(runner).getByRole("button", { name: "Collapse subagent runner" }))
		expect(within(runner).queryByTestId("subagent-item-body")).not.toBeInTheDocument()
		expect(within(retryer).getByTestId("subagent-item-body")).toBeInTheDocument()
		expect(within(runner).getByTestId("subagent-name")).toHaveTextContent("runner")
		expect(within(runner).getByTestId("subagent-execution-mode")).toHaveTextContent("Foreground")
		expect(runner.querySelector(".lucide-loader-circle")).not.toBeNull()

		const finishButton = within(runner).getByRole("button", { name: "Finish" })
		fireEvent.click(finishButton)
		fireEvent.click(within(runner).getByRole("button", { name: "Cancel" }))
		expect(finishTaskActivities).toHaveBeenCalledWith("task-1", ["job-runner"])
		expect(cancelTaskActivities).toHaveBeenCalledWith("task-1", ["job-runner"])
		expect(within(runner).queryByTestId("subagent-item-body")).not.toBeInTheDocument()

		fireEvent.click(within(retryer).getByRole("button", { name: "Collapse subagent retryer" }))
		const retryButton = within(retryer).getByRole("button", { name: "Retry" })
		fireEvent.click(retryButton)
		expect(retryTaskActivities).toHaveBeenCalledWith("task-1", ["job-retryer"])
		expect(within(retryer).queryByTestId("subagent-item-body")).not.toBeInTheDocument()
		fireEvent.click(within(retryer).getByRole("button", { name: "Expand subagent retryer" }))
		expect(within(retryer).getByTestId("subagent-item-body")).toBeInTheDocument()
		await waitFor(() => {
			expect(finishButton).not.toBeDisabled()
			expect(retryButton).not.toBeDisabled()
		})
	})

	it("bounds expanded subagent output inside the individual item", () => {
		const msg = makeMsg({
			say: "subagent",
			text: JSON.stringify({
				status: "completed",
				items: [
					{
						index: 1,
						prompt: "review",
						status: "completed",
						result: "long result",
						toolCalls: 1,
						inputTokens: 10,
						outputTokens: 5,
						totalCost: 0,
						currency: "USD",
						contextTokens: 15,
						contextWindow: 200000,
						contextUsagePercentage: 0.01,
					},
				],
			}),
		})

		render(<SubagentStatusRow isLast={true} message={msg} />)
		fireEvent.click(screen.getByRole("button", { name: "Show subagent output" }))

		expect(screen.getByTestId("subagent-output").parentElement).toHaveClass("min-h-0", "overflow-y-auto")
		expect(screen.getByTestId("subagent-output").parentElement).toHaveAttribute("data-testid", "subagent-output-scroll")
	})
})
