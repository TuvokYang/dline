import type { TaskViewState } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FooterActions } from "../FooterActions"

/** Create one tool approval view with exact causal identity. */
function approvalView(): TaskViewState {
	return {
		taskId: "task-1",
		taskInstanceId: "task-instance-1",
		phase: "awaiting_approval",
		stateRevision: 8,
		activeInteraction: {
			taskId: "task-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			kind: "tool_approval",
			status: "awaiting",
			stateRevision: 8,
			taskAsk: "tool",
			presentationKind: "tool_approval",
			askMessageTs: 100,
		},
		input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true },
		footer: {
			actions: [
				{
					type: "approve",
					label: "Approve",
					appearance: "primary",
					enabled: true,
					payloadPolicy: "draft",
					dispatchTarget: "interaction",
				},
				{
					type: "reject",
					label: "Reject",
					appearance: "danger",
					enabled: true,
					payloadPolicy: "draft",
					dispatchTarget: "interaction",
				},
			],
		},
	}
}

describe("FooterActions", () => {
	it("dispatches exact causal identity and settles the captured draft only when accepted", async () => {
		const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
		const onDraftAccepted = vi.fn()
		const draft = {
			text: "use smaller steps",
			images: ["image"],
			files: ["file"],
			activeQuote: "quoted context",
		}
		render(
			<FooterActions
				dispatch={dispatch}
				draft={draft}
				onDraftAccepted={onDraftAccepted}
				selection={{ values: ["item-1"] }}
				view={approvalView()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Approve" }))

		await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
		expect(dispatch).toHaveBeenCalledWith({
			taskId: "task-1",
			taskInstanceId: "task-instance-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			actionId: "approve",
			stateRevision: 8,
			draft: { text: "use smaller steps", images: ["image"], files: ["file"] },
			selection: { values: ["item-1"] },
		})
		await waitFor(() =>
			expect(onDraftAccepted).toHaveBeenCalledWith({
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				stateRevision: 8,
				draft,
			}),
		)
	})

	// Every submit path now clears optimistically, so the draft survives a
	// rejection through rollback rather than by never being cleared. The user
	// still ends up with their text; only the mechanism changed.
	it("hands the draft back when the backend rejects the interaction", async () => {
		const dispatch = vi.fn(async () => ({ accepted: false, result: "stale interaction" }))
		const onDraftAccepted = vi.fn()
		const onDraftRejected = vi.fn()
		const draft = { text: "keep me", images: ["image"], files: ["file"] }
		render(
			<FooterActions
				dispatch={dispatch}
				draft={draft}
				onDraftAccepted={onDraftAccepted}
				onDraftRejected={onDraftRejected}
				view={approvalView()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Reject" }))

		await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
		const settlement = {
			taskId: "task-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			stateRevision: 8,
			draft: { ...draft, activeQuote: null, ownerRevision: undefined },
		}
		expect(onDraftAccepted).toHaveBeenCalledWith(settlement)
		await waitFor(() => expect(onDraftRejected).toHaveBeenCalledWith(settlement))
		expect(await screen.findByRole("alert")).toHaveTextContent("Interaction was not accepted: stale interaction")
		expect(screen.getByRole("button", { name: "Reject" })).toBeEnabled()
	})

	it("hands the draft back when the dispatch itself fails", async () => {
		const dispatch = vi.fn(async () => {
			throw new Error("transport failed")
		})
		const onDraftRejected = vi.fn()
		render(
			<FooterActions
				dispatch={dispatch}
				draft={{ text: "keep me", images: [], files: [] }}
				onDraftRejected={onDraftRejected}
				view={approvalView()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Reject" }))

		await waitFor(() => expect(onDraftRejected).toHaveBeenCalledOnce())
		expect(onDraftRejected.mock.calls[0][0]).toMatchObject({ draft: { text: "keep me" } })
	})

	it("confirms Condense Conversation without submitting or settling the current draft", async () => {
		const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
		const onDraftAccepted = vi.fn()
		const view = approvalView()
		if (!view.activeInteraction) throw new Error("Expected active interaction")
		view.activeInteraction = {
			...view.activeInteraction,
			kind: "condense",
			presentationKind: "condense",
			taskAsk: "condense",
		}
		view.footer.actions = [
			{
				type: "confirm_utility",
				label: "Condense Conversation",
				appearance: "primary",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "interaction",
			},
			{
				type: "reject",
				label: "Regenerate Summary",
				appearance: "secondary",
				enabled: true,
				payloadPolicy: "draft",
				dispatchTarget: "interaction",
			},
		]

		render(
			<FooterActions
				dispatch={dispatch}
				draft={{ text: "preserve this draft", images: ["image"], files: ["file"] }}
				onDraftAccepted={onDraftAccepted}
				view={view}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Condense Conversation" }))

		await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
		expect(dispatch).toHaveBeenCalledWith({
			taskId: "task-1",
			taskInstanceId: "task-instance-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			actionId: "confirm_utility",
			stateRevision: 8,
			draft: undefined,
			selection: undefined,
		})
		expect(onDraftAccepted).not.toHaveBeenCalled()
	})

	it("confirms New Task without submitting or settling the current feedback draft", async () => {
		const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
		const onDraftAccepted = vi.fn()
		const onSuccessorAccepted = vi.fn()
		const view = approvalView()
		if (!view.activeInteraction) throw new Error("Expected active interaction")
		view.activeInteraction = {
			...view.activeInteraction,
			kind: "new_task",
			presentationKind: "new_task",
			taskAsk: "new_task",
		}
		view.footer.actions = [
			{
				type: "approve",
				label: "Start New Task",
				appearance: "primary",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "interaction",
			},
			{
				type: "reject",
				label: "Regenerate Context",
				appearance: "secondary",
				enabled: true,
				payloadPolicy: "draft",
				dispatchTarget: "interaction",
			},
		]

		render(
			<FooterActions
				dispatch={dispatch}
				draft={{ text: "Do not submit this", images: ["image"], files: ["file"] }}
				onDraftAccepted={onDraftAccepted}
				onSuccessorAccepted={onSuccessorAccepted}
				successorContext="Successor context"
				view={view}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Start New Task" }))

		await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
		expect(dispatch).toHaveBeenCalledWith({
			taskId: "task-1",
			taskInstanceId: "task-instance-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			actionId: "approve",
			stateRevision: 8,
			draft: undefined,
			selection: undefined,
		})
		expect(onDraftAccepted).not.toHaveBeenCalled()
		expect(onSuccessorAccepted).toHaveBeenCalledWith({
			sourceTaskId: "task-1",
			context: "Successor context",
			draft: {
				text: "Do not submit this",
				images: ["image"],
				files: ["file"],
				activeQuote: null,
			},
		})
	})

	it("submits and settles New Task feedback through Regenerate Context", async () => {
		const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
		const onDraftAccepted = vi.fn()
		const view = approvalView()
		if (!view.activeInteraction) throw new Error("Expected active interaction")
		view.activeInteraction = {
			...view.activeInteraction,
			kind: "new_task",
			presentationKind: "new_task",
			taskAsk: "new_task",
		}
		view.input.enterAction = "reject"
		view.footer.actions = [
			{
				type: "approve",
				label: "Start New Task",
				appearance: "primary",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "interaction",
			},
			{
				type: "reject",
				label: "Regenerate Context",
				appearance: "secondary",
				enabled: true,
				payloadPolicy: "draft",
				dispatchTarget: "interaction",
			},
		]
		const draft = { text: "Keep the compatibility constraints", images: ["image"], files: ["file"] }

		render(<FooterActions dispatch={dispatch} draft={draft} onDraftAccepted={onDraftAccepted} view={view} />)
		fireEvent.click(screen.getByRole("button", { name: "Regenerate Context" }))

		await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
		expect(dispatch).toHaveBeenCalledWith({
			taskId: "task-1",
			taskInstanceId: "task-instance-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			actionId: "reject",
			stateRevision: 8,
			draft,
			selection: undefined,
		})
		expect(onDraftAccepted).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.objectContaining(draft) }))
	})

	it("submits and settles feedback through Regenerate Summary", async () => {
		const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
		const onDraftAccepted = vi.fn()
		const view = approvalView()
		if (!view.activeInteraction) throw new Error("Expected active interaction")
		view.activeInteraction = {
			...view.activeInteraction,
			kind: "condense",
			presentationKind: "condense",
			taskAsk: "condense",
		}
		view.input.enterAction = "reject"
		view.footer.actions = [
			{
				type: "confirm_utility",
				label: "Condense Conversation",
				appearance: "primary",
				enabled: true,
				payloadPolicy: "draft",
				dispatchTarget: "interaction",
			},
			{
				type: "reject",
				label: "Regenerate Summary",
				appearance: "secondary",
				enabled: true,
				payloadPolicy: "draft",
				dispatchTarget: "interaction",
			},
		]
		const draft = { text: "Keep the deployment details", images: ["image"], files: ["file"] }

		render(<FooterActions dispatch={dispatch} draft={draft} onDraftAccepted={onDraftAccepted} view={view} />)
		fireEvent.click(screen.getByRole("button", { name: "Regenerate Summary" }))

		await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
		expect(dispatch).toHaveBeenCalledWith({
			taskId: "task-1",
			taskInstanceId: "task-instance-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			actionId: "reject",
			stateRevision: 8,
			draft: { text: "Keep the deployment details", images: ["image"], files: ["file"] },
			selection: undefined,
		})
		expect(onDraftAccepted).toHaveBeenCalledWith(expect.objectContaining({ draft: expect.objectContaining(draft) }))
	})

	it("shows an interaction dispatch failure and restores the action", async () => {
		const dispatch = vi.fn(async () => {
			throw new Error("dispatch unavailable")
		})
		render(<FooterActions dispatch={dispatch} draft={{ text: "keep me", images: [], files: [] }} view={approvalView()} />)

		fireEvent.click(screen.getByRole("button", { name: "Approve" }))

		expect(await screen.findByRole("alert")).toHaveTextContent("dispatch unavailable")
		await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeEnabled())
	})

	it("dispatches projected cancel through the task command boundary", async () => {
		const view = approvalView()
		delete view.activeInteraction
		view.phase = "streaming"
		view.footer.actions = [
			{
				type: "cancel",
				label: "Cancel",
				appearance: "danger",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "task",
			},
		]
		const dispatchTaskAction = vi.fn(async () => undefined)

		render(
			<FooterActions
				dispatch={vi.fn()}
				dispatchTaskAction={dispatchTaskAction}
				draft={{ text: "", images: [], files: [] }}
				view={view}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		await waitFor(() => expect(dispatchTaskAction).toHaveBeenCalledWith(expect.objectContaining({ type: "cancel" })))
	})

	it("renders Continue in Background before Cancel and dispatches both task actions", async () => {
		const view = approvalView()
		delete view.activeInteraction
		view.phase = "executing"
		view.footer.actions = [
			{
				type: "continue_in_background",
				label: "Continue in Background",
				appearance: "secondary",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "task",
				activityId: "command-1",
			},
			{
				type: "cancel",
				label: "Cancel",
				appearance: "danger",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "task",
			},
		]
		const dispatchTaskAction = vi.fn(async () => undefined)

		render(
			<FooterActions
				dispatch={vi.fn()}
				dispatchTaskAction={dispatchTaskAction}
				draft={{ text: "", images: [], files: [] }}
				view={view}
			/>,
		)
		const actionButtons = screen.getAllByRole("button")
		expect(actionButtons.map((button) => button.getAttribute("aria-label"))).toEqual(["Continue in Background", "Cancel"])
		const actionGroup = actionButtons[0].parentElement
		expect(actionGroup).toHaveClass("flex", "gap-1.5")
		expect(actionGroup).not.toHaveClass("border", "rounded")
		expect(actionButtons[0]).toHaveClass("border", "border-(--vscode-panel-border)", "rounded")
		expect(actionButtons[1]).toHaveClass("border", "border-(--vscode-panel-border)", "rounded")
		fireEvent.click(actionButtons[0])

		await waitFor(() =>
			expect(dispatchTaskAction).toHaveBeenCalledWith(
				expect.objectContaining({ type: "continue_in_background", activityId: "command-1" }),
			),
		)
		fireEvent.click(actionButtons[1])
		await waitFor(() => expect(dispatchTaskAction).toHaveBeenCalledWith(expect.objectContaining({ type: "cancel" })))
	})

	it("shows a task action dispatch failure and restores the action", async () => {
		const view = approvalView()
		delete view.activeInteraction
		view.phase = "streaming"
		view.footer.actions = [
			{
				type: "cancel",
				label: "Cancel",
				appearance: "danger",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "task",
			},
		]
		const dispatchTaskAction = vi.fn(async () => {
			throw new Error("cancel unavailable")
		})

		render(
			<FooterActions
				dispatch={vi.fn()}
				dispatchTaskAction={dispatchTaskAction}
				draft={{ text: "", images: [], files: [] }}
				view={view}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		expect(await screen.findByRole("alert")).toHaveTextContent("cancel unavailable")
		await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled())
	})

	// Cancel clean-up can take seconds. The footer must follow the backend
	// projection instead of holding every action hostage until the cancel RPC
	// resolves, otherwise the resume action that cancelling produced is still
	// disabled once it is already on screen.
	it("enables the next projected action once cancel has been received, without waiting for the RPC", async () => {
		const streamingView = approvalView()
		delete streamingView.activeInteraction
		streamingView.phase = "streaming"
		streamingView.footer.actions = [
			{
				type: "cancel",
				label: "Cancel",
				appearance: "danger",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "task",
			},
		]
		// The clean-up transaction never settles during this test.
		const dispatchTaskAction = vi.fn(() => new Promise<void>(() => {}))

		const { rerender } = render(
			<FooterActions
				dispatch={vi.fn()}
				dispatchTaskAction={dispatchTaskAction}
				draft={{ text: "", images: [], files: [] }}
				view={streamingView}
			/>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		await waitFor(() => expect(dispatchTaskAction).toHaveBeenCalledOnce())

		// The backend has already committed the cancellation and projected the
		// resume interaction, even though the cancel RPC is still in flight.
		const resumedView = approvalView()
		resumedView.phase = "paused"
		resumedView.stateRevision = 9
		if (!resumedView.activeInteraction) throw new Error("Expected active interaction")
		resumedView.activeInteraction = {
			...resumedView.activeInteraction,
			kind: "resume",
			presentationKind: "resume",
			taskAsk: "resume_task",
			stateRevision: 9,
		}
		resumedView.footer.actions = [
			{
				type: "resume",
				label: "Resume",
				appearance: "primary",
				enabled: true,
				payloadPolicy: "draft",
				dispatchTarget: "interaction",
			},
		]
		rerender(
			<FooterActions
				dispatch={vi.fn()}
				dispatchTaskAction={dispatchTaskAction}
				draft={{ text: "", images: [], files: [] }}
				view={resumedView}
			/>,
		)

		expect(screen.getByRole("button", { name: "Resume" })).toHaveAttribute("aria-disabled", "false")
	})

	// While the projection still shows the cancellable phase, the cancel button
	// itself must not accept a second click.
	it("keeps cancel disabled while its own projection is unchanged", async () => {
		const view = approvalView()
		delete view.activeInteraction
		view.phase = "streaming"
		view.footer.actions = [
			{
				type: "cancel",
				label: "Cancel",
				appearance: "danger",
				enabled: true,
				payloadPolicy: "none",
				dispatchTarget: "task",
			},
		]
		const dispatchTaskAction = vi.fn(() => new Promise<void>(() => {}))

		render(
			<FooterActions
				dispatch={vi.fn()}
				dispatchTaskAction={dispatchTaskAction}
				draft={{ text: "", images: [], files: [] }}
				view={view}
			/>,
		)
		expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("aria-disabled", "false")
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveAttribute("aria-disabled", "true"))
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		expect(dispatchTaskAction).toHaveBeenCalledOnce()
	})

	it("keeps the explicit Resume button when Enter can also resume", () => {
		const view = approvalView()
		if (!view.activeInteraction) {
			throw new Error("Expected active interaction")
		}
		view.activeInteraction = { ...view.activeInteraction, kind: "resume", presentationKind: "resume", taskAsk: "resume_task" }
		view.input.enterAction = "resume"
		view.footer.actions = [
			{
				type: "resume",
				label: "Resume",
				appearance: "primary",
				enabled: true,
				payloadPolicy: "draft",
				dispatchTarget: "interaction",
			},
		]

		render(<FooterActions dispatch={vi.fn()} draft={{ text: "", images: [], files: [] }} view={view} />)

		expect(screen.getByRole("button", { name: "Resume" })).toBeVisible()
	})
})
