import type { ClineAsk, ClineMessage, TaskViewActionType, TaskViewState } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TaskServiceClient } from "@/services/grpc-client"
import { InteractionHost } from "../InteractionHost"

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		cancelTask: vi.fn(async () => undefined),
		moveCommandToBackground: vi.fn(async () => ({ moved: true })),
	},
}))

const ASK: ClineMessage = {
	ts: 100,
	type: "ask",
	ask: "tool",
	text: "Approve write",
	interactionId: "interaction-1",
}
const SAY: ClineMessage = { ts: 90, type: "say", say: "text", text: "status text" }

/** Create one active interaction view anchored to timestamp 100. */
function taskView(): TaskViewState {
	return {
		taskId: "task-1",
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

function configureInteraction(
	view: TaskViewState,
	input: {
		kind: string
		taskAsk: ClineAsk
		presentationKind: string
		action: TaskViewActionType
		label: string
		enterAction?: TaskViewActionType
	},
): ClineMessage {
	if (!view.activeInteraction) throw new Error("Expected active interaction")
	view.phase = input.kind === "completion" ? "completed" : "paused"
	view.activeInteraction = {
		...view.activeInteraction,
		kind: input.kind,
		taskAsk: input.taskAsk,
		presentationKind: input.presentationKind,
	}
	view.input.enterAction = input.enterAction
	view.footer.actions = [
		{
			type: input.action,
			label: input.label,
			appearance: "primary",
			enabled: true,
			payloadPolicy: "draft",
			dispatchTarget: "interaction",
		},
	]
	return { ...ASK, ask: input.taskAsk, text: input.label }
}

describe("InteractionHost", () => {
	beforeEach(() => {
		vi.mocked(TaskServiceClient.cancelTask).mockClear()
		vi.mocked(TaskServiceClient.moveCommandToBackground).mockClear()
	})

	it("renders say content without actions when no interaction exists", () => {
		const view = taskView()
		delete view.activeInteraction
		view.footer.actions = []

		render(<InteractionHost dispatch={vi.fn()} messages={[SAY]} view={view} />)

		expect(screen.getByText("status text")).toBeVisible()
		expect(screen.queryByRole("button")).toBeNull()
	})

	it("renders matching ask presentation and exact approval actions", () => {
		render(<InteractionHost dispatch={vi.fn()} messages={[SAY, ASK]} view={taskView()} />)

		expect(screen.getByText("Approve write")).toBeVisible()
		expect(screen.getByRole("button", { name: "Approve" })).toBeVisible()
		expect(screen.getByRole("button", { name: "Reject" })).toBeVisible()
	})

	it("dispatches approval with exact identity and the owned draft", async () => {
		const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
		render(
			<InteractionHost
				dispatch={dispatch}
				draft={{ text: "approval feedback", images: ["image"], files: ["file"] }}
				messages={[ASK]}
				view={taskView()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Approve" }))

		await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
		expect(dispatch).toHaveBeenCalledWith({
			taskId: "task-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			actionId: "approve",
			stateRevision: 8,
			draft: { text: "approval feedback", images: ["image"], files: ["file"] },
			selection: { values: [] },
		})
	})

	it("does not duplicate an Enter-owned reply action as a footer button", () => {
		const view = taskView()
		const message = configureInteraction(view, {
			kind: "qna_response",
			taskAsk: "qna_respond",
			presentationKind: "qna_response",
			action: "reply",
			label: "Reply",
			enterAction: "reply",
		})

		render(<InteractionHost dispatch={vi.fn()} messages={[message]} view={view} />)

		expect(screen.queryByRole("button", { name: "Reply" })).toBeNull()
	})

	it("dispatches host-owned focus-chain selection with approve", async () => {
		const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
		const view = taskView()
		if (!view.activeInteraction) throw new Error("Expected active interaction")
		view.activeInteraction = {
			...view.activeInteraction,
			kind: "change_todo_list",
			presentationKind: "focus_chain_change",
			taskAsk: "change_todo_list",
		}
		const message: ClineMessage = {
			...ASK,
			ask: "change_todo_list",
			text: JSON.stringify({ plan: "# Plan\n- [ ] First item\n- [ ] Second item", reason: "Review" }),
		}
		render(<InteractionHost dispatch={dispatch} messages={[message]} view={view} />)

		fireEvent.click(screen.getByLabelText("Second item"))
		fireEvent.click(screen.getByRole("button", { name: "Approve" }))

		await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
		expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ selection: { values: ["1"] } }))
	})

	it("moves the projected foreground command to the background from the footer", async () => {
		const view = taskView()
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
		render(<InteractionHost dispatch={vi.fn()} messages={[SAY]} view={view} />)

		fireEvent.click(screen.getByRole("button", { name: "Continue in Background" }))

		await waitFor(() =>
			expect(TaskServiceClient.moveCommandToBackground).toHaveBeenCalledWith(
				expect.objectContaining({ taskId: "task-1", activityId: "command-1" }),
			),
		)
		expect(TaskServiceClient.cancelTask).not.toHaveBeenCalled()

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
		await waitFor(() => expect(TaskServiceClient.cancelTask).toHaveBeenCalledOnce())
	})

	it.each([
		["timestamp", { ...ASK, ts: 101 }],
		["missing interaction identity", { ...ASK, interactionId: undefined }],
		["interaction identity", { ...ASK, interactionId: "interaction-2" }],
		["task ask", { ...ASK, ask: "command" as const }],
	])("withholds controls for a mismatched %s anchor without offering manual reload", (_field, message) => {
		render(<InteractionHost dispatch={vi.fn()} messages={[SAY, message]} view={taskView()} />)

		expect(screen.getByText("status text")).toBeVisible()
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
	})

	it("withholds controls when the exact approval anchor is still partial", () => {
		render(<InteractionHost dispatch={vi.fn()} messages={[SAY, { ...ASK, partial: true }]} view={taskView()} />)

		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
		expect(screen.queryByRole("button", { name: "Reject" })).toBeNull()
		expect(screen.getByRole("alert")).toHaveTextContent(/message anchor could not be matched/i)
	})

	it("withholds controls when the exact anchor identity is duplicated", () => {
		render(<InteractionHost dispatch={vi.fn()} messages={[ASK, { ...ASK, text: "Duplicate ask" }]} view={taskView()} />)

		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
	})

	it("explains why an awaiting interaction lost its controls when no anchor matches", () => {
		// The backend anchor is intact here, so no diagnostic arrives. Without a
		// local notice the approval row would vanish silently while the task waits.
		render(<InteractionHost dispatch={vi.fn()} messages={[SAY, { ...ASK, interactionId: undefined }]} view={taskView()} />)

		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
		expect(screen.getByRole("alert")).toHaveTextContent(/message anchor could not be matched/i)
	})

	it("renders the exact approval summary above actions in footer-only mode", () => {
		render(<InteractionHost dispatch={vi.fn()} messages={[SAY, ASK]} showTimeline={false} view={taskView()} />)

		expect(screen.getByText("Approve write")).toBeVisible()
		expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute("aria-disabled", "false")
		expect(screen.queryByRole("alert")).toBeNull()
	})

	it("renders a typed file approval summary instead of raw JSON", () => {
		const message = {
			...ASK,
			text: JSON.stringify({ tool: "newFileCreated", path: "src/new-file.ts", content: "export const value = 1" }),
		}
		render(<InteractionHost dispatch={vi.fn()} messages={[message]} showTimeline={false} view={taskView()} />)

		expect(screen.getByText("Dline wants to create this file:")).toBeVisible()
		expect(screen.getByText("src/new-file.ts")).toBeVisible()
		expect(screen.queryByText(message.text)).toBeNull()
	})

	it("keeps the typed image approval card and prompt above footer actions", () => {
		const message = {
			...ASK,
			text: JSON.stringify({
				tool: "generateImage",
				imageGeneration: {
					schemaVersion: 1,
					status: "awaiting_approval",
					requestId: "image-request-1",
					prompt: "A blue owl",
					count: 2,
				},
			}),
		}
		render(<InteractionHost dispatch={vi.fn()} messages={[message]} showTimeline={false} view={taskView()} />)

		expect(screen.getByText("Dline wants to generate an image")).toBeVisible()
		expect(screen.getByText("A blue owl")).toBeVisible()
		expect(screen.getByText("2 images requested")).toBeVisible()
		expect(screen.getByRole("button", { name: "Approve" })).toBeVisible()
		expect(screen.getByRole("button", { name: "Reject" })).toBeVisible()
	})

	it("does not duplicate an API retry error above its footer controls", () => {
		const view = taskView()
		const message = configureInteraction(view, {
			kind: "error_retry",
			taskAsk: "api_req_failed",
			presentationKind: "error_retry",
			action: "retry",
			label: "Retry",
		})
		message.text = '{"message":"Connection error.","providerId":"anthropic"}'

		render(<InteractionHost dispatch={vi.fn()} messages={[message]} showTimeline={false} view={view} />)

		expect(screen.queryByTestId("error-presentation-box")).toBeNull()
		expect(screen.getByRole("button", { name: "Retry" })).toBeVisible()
	})

	it("renders verified interaction actions in footer-only mode before the message window catches up", () => {
		const view = taskView()
		if (!view.activeInteraction) throw new Error("Expected active interaction")
		view.activeInteraction.anchorVerified = true

		render(<InteractionHost dispatch={vi.fn()} messages={[SAY]} showTimeline={false} view={view} />)

		expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute("aria-disabled", "false")
		expect(screen.queryByRole("alert")).toBeNull()
	})

	it("keeps the backend diagnostic as the only alert when one is supplied", () => {
		const view = taskView()
		view.diagnostic = { code: "interaction_anchor_missing", interactionId: "interaction-1" }

		render(<InteractionHost dispatch={vi.fn()} messages={[SAY]} view={view} />)

		const alerts = screen.getAllByRole("alert")
		expect(alerts).toHaveLength(1)
		expect(alerts[0]).toHaveTextContent(/could not restore the saved interaction message/i)
	})

	it("does not warn about anchors once the interaction is resolved", () => {
		const view = taskView()
		delete view.activeInteraction
		view.footer.actions = []

		render(<InteractionHost dispatch={vi.fn()} messages={[SAY]} view={view} />)

		expect(screen.queryByRole("alert")).toBeNull()
	})

	it("renders a backend interaction diagnostic without inventing an action", () => {
		const view = taskView()
		delete view.activeInteraction
		view.input = { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false }
		view.footer.actions = []
		view.diagnostic = { code: "interaction_anchor_missing", interactionId: "interaction-1" }

		render(<InteractionHost dispatch={vi.fn()} messages={[SAY]} view={view} />)

		expect(screen.getByRole("alert")).toHaveTextContent("saved interaction message")
		expect(screen.queryByRole("button")).toBeNull()
	})

	it("keeps task cancellation available while interaction controls wait for their exact anchor", async () => {
		const view = taskView()
		view.phase = "executing"
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
		render(<InteractionHost dispatch={vi.fn()} messages={[SAY]} view={view} />)

		fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

		await waitFor(() => expect(TaskServiceClient.cancelTask).toHaveBeenCalledOnce())
		expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
	})

	it.each([
		{
			name: "Resume",
			kind: "resume",
			taskAsk: "resume_task" as const,
			presentationKind: "resume",
			action: "resume" as const,
			enterAction: "resume" as const,
		},
		{
			name: "Retry",
			kind: "error_retry",
			taskAsk: "api_req_failed" as const,
			presentationKind: "error_retry",
			action: "retry" as const,
			enterAction: "retry" as const,
		},
		{
			name: "Start New Task",
			kind: "completion",
			taskAsk: "completion_result" as const,
			presentationKind: "completion",
			action: "start_new_task" as const,
			enterAction: "reply" as const,
		},
	])("dispatches $name through the exact anchored interaction", async (interaction) => {
		const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
		const view = taskView()
		const message = configureInteraction(view, { ...interaction, label: interaction.name })
		render(<InteractionHost dispatch={dispatch} messages={[message]} view={view} />)

		fireEvent.click(screen.getByRole("button", { name: interaction.name }))

		await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				turnId: "turn-1",
				interactionId: "interaction-1",
				actionId: interaction.action,
				stateRevision: 8,
			}),
		)
	})

	it("renders an unsupported interaction ask as read-only without fallback controls", () => {
		const view = taskView()
		if (!view.activeInteraction) throw new Error("Expected active interaction")
		view.activeInteraction.presentationKind = "unsupported"

		render(<InteractionHost dispatch={vi.fn()} messages={[ASK]} view={view} />)

		expect(screen.getByText("Approve write")).toBeVisible()
		expect(screen.queryByRole("button")).toBeNull()
	})
})
