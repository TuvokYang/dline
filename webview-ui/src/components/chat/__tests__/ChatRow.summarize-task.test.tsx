import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { CheckpointsServiceClient } from "../../../services/grpc-client"
import { ChatRowContent } from "../ChatRow"

vi.mock("../../../context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		backgroundEditEnabled: true,
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

vi.mock("../../../services/grpc-client", () => ({
	CheckpointsServiceClient: {
		checkpointDiff: vi.fn(async () => ({})),
		checkpointRestore: vi.fn(async () => ({})),
	},
}))

const baseProps = {
	isLast: true,
	onSetQuote: vi.fn(),
	onToggleExpand: vi.fn(),
}

describe("ChatRow summarizeTask rendering", () => {
	it("renders the streamed summary content while expanded", () => {
		const content = "The user asked to fix the web tools auth issue and the work is in progress."
		render(
			<ChatRowContent
				{...baseProps}
				isExpanded={true}
				message={{
					ts: 1,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({ tool: "summarizeTask", content }),
				}}
			/>,
		)

		expect(screen.getByText("Summary:")).toBeInTheDocument()
		expect(screen.getByText(content)).toBeInTheDocument()
	})

	it("renders a retrying compaction without presenting the partial text as a completed summary", () => {
		render(
			<ChatRowContent
				{...baseProps}
				isExpanded={true}
				message={{
					ts: 10,
					type: "say",
					say: "tool",
					partial: true,
					text: JSON.stringify({
						tool: "summarizeTask",
						content: "partial summary that must not be applied",
						compactionStatus: "retrying",
						retryAttempt: 2,
						maxRetryAttempts: 3,
						compactionOperationId: "operation-1",
						compactionPassIndex: 4,
						compactionAttemptIndex: 2,
						compactionAttemptId: "attempt-2",
					}),
				}}
			/>,
		)

		expect(screen.getByText(/Compaction was interrupted.*retrying/i)).toBeInTheDocument()
		expect(screen.getByText(/attempt 2 of 3/i)).toBeInTheDocument()
		expect(screen.getByText("Partial summary (not applied):")).toBeInTheDocument()
		expect(screen.queryByText("Summary:")).not.toBeInTheDocument()
		expect(screen.getByTestId("compaction-pass")).toHaveAttribute("data-compaction-operation-id", "operation-1")
		expect(screen.getByTestId("compaction-pass")).toHaveAttribute("data-compaction-pass-index", "4")
		expect(screen.getByTestId("compaction-pass")).toHaveAttribute("data-compaction-attempt-index", "2")
		expect(screen.getByTestId("compaction-pass")).toHaveAttribute("data-compaction-attempt-id", "attempt-2")
	})

	it.each([
		["preparing", "Preparing a context-safe summary:"],
		["waiting", "Waiting for the model to begin compaction:"],
		["receiving", "Dline is condensing the conversation:"],
	] as const)("renders an explicit %s lifecycle card before summary content", (compactionStatus, expectedTitle) => {
		render(
			<ChatRowContent
				{...baseProps}
				isExpanded={true}
				message={{
					ts: 11,
					type: "say",
					say: "tool",
					partial: true,
					text: JSON.stringify({
						tool: "summarizeTask",
						content: "",
						compactionStatus,
						compactionOperationId: "operation-lifecycle",
						compactionUnitKind: "pass",
						compactionUnitIndex: 2,
						compactionDurable: false,
					}),
				}}
			/>,
		)

		const card = screen.getByTestId("compaction-pass")
		expect(card).toHaveAttribute("data-compaction-status", compactionStatus)
		expect(card).toHaveAttribute("data-compaction-unit-kind", "pass")
		expect(card).toHaveAttribute("data-compaction-unit-index", "2")
		expect(card).toHaveAttribute("data-compaction-durable", "false")
		expect(screen.queryByText("Live")).not.toBeInTheDocument()
		expect(screen.getByText(expectedTitle)).toBeInTheDocument()
	})

	it("renders summary refit as an independent execution-unit card", () => {
		render(
			<ChatRowContent
				{...baseProps}
				isExpanded={true}
				message={{
					ts: 12,
					type: "say",
					say: "tool",
					partial: true,
					text: JSON.stringify({
						tool: "summarizeTask",
						content: "strictly smaller cumulative summary",
						compactionStatus: "receiving",
						compactionOperationId: "operation-refit",
						compactionUnitKind: "summary_refit",
						compactionUnitIndex: 0,
					}),
				}}
			/>,
		)

		const card = screen.getByTestId("compaction-pass")
		expect(card).toHaveAttribute("data-compaction-unit-kind", "summary_refit")
		expect(card).toHaveAttribute("data-compaction-unit-index", "0")
		expect(screen.getByText("Dline is refitting the cumulative summary:")).toBeInTheDocument()
		expect(screen.getByText("strictly smaller cumulative summary")).toBeInTheDocument()
	})

	it("renders explicit durable state and a single visual card surface", () => {
		render(
			<ChatRowContent
				{...baseProps}
				isExpanded={true}
				message={{
					ts: 15,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "summarizeTask",
						content: "durably committed summary",
						compactionStatus: "completed",
						compactionOperationId: "operation-durable",
						compactionUnitKind: "pass",
						compactionUnitIndex: 1,
						compactionDurable: true,
					}),
				}}
			/>,
		)

		const card = screen.getByTestId("compaction-pass")
		expect(card).toHaveAttribute("data-compaction-durable", "true")
		// The card root carries identity only; exactly one nested element draws the surface,
		// which keeps the checkpoint control outside the clipping box.
		const surfaces = card.querySelectorAll(".bg-code.border.border-editor-group-border")
		expect(surfaces).toHaveLength(1)
		expect(surfaces[0]).toHaveClass("rounded-[3px]")
		// Durability is diagnostic metadata only; it must not reach the card header.
		expect(screen.queryByTestId("compaction-durability")).not.toBeInTheDocument()
		expect(screen.queryByText("Durable")).not.toBeInTheDocument()
		const summaryContent = screen.getByTestId("compaction-summary-content")
		expect(summaryContent).not.toHaveClass("bg-code", "border", "border-editor-group-border", "rounded-[3px]")
	})

	it("does not render a historical empty running compaction payload", () => {
		const { container } = render(
			<ChatRowContent
				{...baseProps}
				isExpanded={true}
				message={{
					ts: 12,
					type: "say",
					say: "tool",
					partial: true,
					text: JSON.stringify({ tool: "summarizeTask", content: "", compactionStatus: "running" }),
				}}
			/>,
		)

		expect(container).toBeEmptyDOMElement()
		expect(screen.queryByText(/Preparing a context-safe summary/i)).not.toBeInTheDocument()
	})

	it("keeps a legacy compaction summary visible without rendering its deprecated Restore control", () => {
		render(
			<ChatRowContent
				{...baseProps}
				isExpanded={true}
				message={{
					ts: 13,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "summarizeTask",
						content: "legacy summary remains readable",
						compactionStatus: "completed",
						compactionOperationId: "legacy-operation",
						compactionPrePassCheckpointId: "sha256:pre-pass",
						compactionExpectedHeadCheckpointId: "sha256:post-pass",
						compactionExpectedChainRevision: 2,
					}),
				}}
			/>,
		)

		expect(screen.getByText("legacy summary remains readable")).toBeInTheDocument()
		expect(screen.queryByText("Restore")).not.toBeInTheDocument()
		expect(screen.queryByText("Compaction checkpoint")).not.toBeInTheDocument()
	})

	it("uses ordinary chat-only Restore for a new completed compaction card", async () => {
		vi.mocked(CheckpointsServiceClient.checkpointRestore).mockClear()
		render(
			<ChatRowContent
				{...baseProps}
				isExpanded={true}
				message={{
					ts: 14,
					type: "say",
					say: "tool",
					partial: false,
					conversationHistoryIndex: 3,
					compactionConversationRange: {
						logicalTurnRange: [0, 1],
						apiConversationRange: [0, 3],
						preCompactionApiEndIndex: 3,
					},
					text: JSON.stringify({
						tool: "summarizeTask",
						content: "new durable summary",
						compactionStatus: "completed",
					}),
				}}
			/>,
		)

		expect(screen.queryByRole("button", { name: "Compare", exact: true, hidden: true })).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true, hidden: true }))
		expect(screen.getByRole("button", { name: "Restore Task Only", exact: true })).toBeVisible()
		expect(screen.queryByRole("button", { name: "Restore Files & Task", exact: true })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Restore Files Only", exact: true })).not.toBeInTheDocument()

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Restore Task Only", exact: true }))
		})
		const request = vi.mocked(CheckpointsServiceClient.checkpointRestore).mock.calls[0]?.[0]
		expect(request).toMatchObject({ number: 14, restoreType: "task" })
		expect(request?.compactionOperationId).toBeUndefined()
		expect(request?.compactionCheckpointId).toBeUndefined()
		expect(request?.compactionExpectedHeadCheckpointId).toBeUndefined()
		expect(request?.compactionExpectedChainRevision).toBeUndefined()
	})

	it("keeps the checkpoint control outside the compaction card clipping box", () => {
		render(
			<ChatRowContent
				{...baseProps}
				message={{
					ts: 14,
					type: "say",
					say: "tool",
					partial: false,
					compactionConversationRange: {
						logicalTurnRange: [0, 1],
						apiConversationRange: [0, 3],
						preCompactionApiEndIndex: 3,
					},
					text: JSON.stringify({
						tool: "summarizeTask",
						content: "durable summary",
						compactionStatus: "completed",
					}),
				}}
			/>,
		)

		const card = screen.getByTestId("compaction-pass")
		const restore = screen.getByRole("button", { name: "Restore", exact: true, hidden: true })
		// The control must stay in the card, but never inside the overflow-hidden surface
		// that clips the summary, otherwise its menu and hover target are occluded.
		expect(card).toContainElement(restore)
		const clippingBox = card.querySelector(".overflow-hidden")
		expect(clippingBox).not.toBeNull()
		expect(clippingBox?.contains(restore)).toBe(false)
	})

	it("renders a terminal failure as a standalone error card without compaction card chrome", () => {
		render(
			<ChatRowContent
				{...baseProps}
				isExpanded={true}
				message={{
					ts: 11,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({
						tool: "summarizeTask",
						content: "E2E_MANUAL_INCOMPLETE_PARTIAL_MUST_NOT_RENDER",
						compactionStatus: "failed",
						error: "The summary exceeded the request output limit.",
					}),
				}}
			/>,
		)

		// A failure carries no summary, so it must not borrow the summary card surface.
		expect(screen.queryByTestId("compaction-pass")).not.toBeInTheDocument()
		expect(screen.getByTestId("compaction-failure")).toBeInTheDocument()
		expect(screen.getByTestId("compaction-error-box")).toBeInTheDocument()
		expect(screen.queryByText("Conversation compaction failed:")).not.toBeInTheDocument()
		expect(screen.queryByText("E2E_MANUAL_INCOMPLETE_PARTIAL_MUST_NOT_RENDER")).not.toBeInTheDocument()
		expect(screen.getByText("The summary exceeded the request output limit.")).toBeInTheDocument()
		expect(screen.queryByText("Dline is condensing the conversation:")).not.toBeInTheDocument()
	})

	it("caps the expanded automatic summary at 60% of the viewport with internal scrolling", () => {
		render(
			<ChatRowContent
				{...baseProps}
				isExpanded={true}
				message={{
					ts: 1,
					type: "say",
					say: "tool",
					partial: false,
					text: JSON.stringify({ tool: "summarizeTask", content: "long summary content" }),
				}}
			/>,
		)

		const scrollContainer = screen.getByTestId("summary-scroll-container")
		expect(scrollContainer).toHaveTextContent("long summary content")
		expect(scrollContainer).toHaveClass("max-h-[60vh]")
		expect(scrollContainer).toHaveClass("overflow-y-auto")
		expect(scrollContainer.style.maxHeight).toBe("60vh")
		expect(scrollContainer.style.overflowY).toBe("auto")
	})

	it("caps the manual condense summary at 60% of the viewport with internal scrolling", () => {
		render(
			<ChatRowContent
				{...baseProps}
				isExpanded={true}
				message={{
					ts: 5,
					type: "ask",
					ask: "condense",
					partial: false,
					text: "manual long summary content",
				}}
			/>,
		)

		const scrollContainer = screen.getByTestId("summary-scroll-container")
		expect(scrollContainer).toHaveTextContent("manual long summary content")
		expect(scrollContainer).toHaveClass("max-h-[60vh]")
		expect(scrollContainer).toHaveClass("overflow-y-auto")
		expect(scrollContainer.style.maxHeight).toBe("60vh")
		expect(scrollContainer.style.overflowY).toBe("auto")
	})

	it("requests one collapse when an expanded summary stops being the latest message", () => {
		const onToggleExpand = vi.fn()
		const message = {
			ts: 2,
			type: "say" as const,
			say: "tool" as const,
			partial: false,
			text: JSON.stringify({ tool: "summarizeTask", content: "summary" }),
		}
		const rendered = render(
			<ChatRowContent {...baseProps} isExpanded={true} isLast={true} message={message} onToggleExpand={onToggleExpand} />,
		)

		rendered.rerender(
			<ChatRowContent {...baseProps} isExpanded={true} isLast={false} message={message} onToggleExpand={onToggleExpand} />,
		)

		expect(onToggleExpand).toHaveBeenCalledOnce()
	})

	it("does not auto-collapse a summary again after the user manually reopens it", () => {
		const onToggleExpand = vi.fn()
		const message = {
			ts: 3,
			type: "say" as const,
			say: "tool" as const,
			partial: false,
			text: JSON.stringify({ tool: "summarizeTask", content: "summary" }),
		}
		const rendered = render(
			<ChatRowContent {...baseProps} isExpanded={true} isLast={true} message={message} onToggleExpand={onToggleExpand} />,
		)

		rendered.rerender(
			<ChatRowContent {...baseProps} isExpanded={true} isLast={false} message={message} onToggleExpand={onToggleExpand} />,
		)
		expect(onToggleExpand).toHaveBeenCalledOnce()

		rendered.rerender(
			<ChatRowContent {...baseProps} isExpanded={false} isLast={false} message={message} onToggleExpand={onToggleExpand} />,
		)
		fireEvent.click(screen.getByLabelText("Expand summary"))
		expect(onToggleExpand).toHaveBeenCalledTimes(2)

		rendered.rerender(
			<ChatRowContent {...baseProps} isExpanded={true} isLast={true} message={message} onToggleExpand={onToggleExpand} />,
		)
		rendered.rerender(
			<ChatRowContent {...baseProps} isExpanded={true} isLast={false} message={message} onToggleExpand={onToggleExpand} />,
		)

		expect(onToggleExpand).toHaveBeenCalledTimes(2)
	})

	it("requests one collapse when an expanded focus change stops being the latest message", () => {
		const onToggleExpand = vi.fn()
		const message = {
			ts: 4,
			type: "ask" as const,
			ask: "change_todo_list" as const,
			text: JSON.stringify({ plan: "- [ ] Keep the API boundary", reason: "Changed focus" }),
		}
		const rendered = render(
			<ChatRowContent {...baseProps} isExpanded={true} isLast={true} message={message} onToggleExpand={onToggleExpand} />,
		)

		rendered.rerender(
			<ChatRowContent {...baseProps} isExpanded={true} isLast={false} message={message} onToggleExpand={onToggleExpand} />,
		)

		expect(onToggleExpand).toHaveBeenCalledOnce()
	})
})
