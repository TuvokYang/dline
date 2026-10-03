import type { TaskViewState } from "@shared/ExtensionMessage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { FileServiceClient } from "@/services/grpc-client"
import { TaskInput } from "../TaskInput"

vi.mock("@/services/grpc-client", () => ({
	FileServiceClient: { selectFiles: vi.fn() },
}))

/** Create one resume view where Enter dispatches resume. */
function resumeView(): TaskViewState {
	return {
		taskId: "task-1",
		taskInstanceId: "task-instance-1",
		phase: "paused",
		stateRevision: 9,
		activeInteraction: {
			taskId: "task-1",
			turnId: "turn-1",
			interactionId: "resume-1",
			kind: "resume",
			status: "awaiting",
			stateRevision: 9,
			taskAsk: "resume_task",
			presentationKind: "resume",
			askMessageTs: 100,
		},
		input: {
			enabled: true,
			acceptsText: true,
			acceptsImages: true,
			acceptsFiles: true,
			enterAction: "resume",
		},
		footer: {
			actions: [
				{
					type: "resume",
					label: "Resume",
					appearance: "primary",
					enabled: true,
					payloadPolicy: "draft",
					dispatchTarget: "interaction",
				},
			],
		},
	}
}

describe("TaskInput", () => {
	beforeEach(() => {
		vi.mocked(FileServiceClient.selectFiles).mockReset()
	})
	it("dispatches resume on Enter with the current draft", () => {
		const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
		render(
			<TaskInput
				dispatch={dispatch}
				draft={{ text: "continue carefully", images: [], files: [] }}
				onDraftChange={vi.fn()}
				view={resumeView()}
			/>,
		)

		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" })

		expect(dispatch).toHaveBeenCalledWith({
			taskId: "task-1",
			taskInstanceId: "task-instance-1",
			turnId: "turn-1",
			interactionId: "resume-1",
			actionId: "resume",
			stateRevision: 9,
			draft: { text: "continue carefully", images: [], files: [] },
			selection: undefined,
		})
	})

	it("dispatches completion feedback on Enter", () => {
		const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
		const view = resumeView()
		if (!view.activeInteraction) {
			throw new Error("Expected active interaction")
		}
		view.phase = "completed"
		view.activeInteraction = {
			...view.activeInteraction,
			interactionId: "completion-1",
			kind: "completion",
			taskAsk: "completion_result",
		}
		view.input.enterAction = "reply"
		view.footer.actions = [
			{
				type: "reply",
				label: "Reply",
				appearance: "primary",
				enabled: true,
				payloadPolicy: "draft",
				dispatchTarget: "interaction",
			},
			{
				type: "start_new_task",
				label: "Start New Task",
				appearance: "primary",
				enabled: true,
				payloadPolicy: "draft",
				dispatchTarget: "interaction",
			},
		]

		render(
			<TaskInput
				dispatch={dispatch}
				draft={{ text: "Please refine", images: [], files: [] }}
				onDraftChange={vi.fn()}
				view={view}
			/>,
		)

		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" })

		expect(dispatch).toHaveBeenCalledWith({
			taskId: "task-1",
			taskInstanceId: "task-instance-1",
			turnId: "turn-1",
			interactionId: "completion-1",
			actionId: "reply",
			stateRevision: 9,
			draft: { text: "Please refine", images: [], files: [] },
			selection: undefined,
		})
	})

	it("selects policy-allowed image and file attachments", async () => {
		vi.mocked(FileServiceClient.selectFiles).mockResolvedValue({ values1: ["image-1"], values2: ["file-1"] })
		const onDraftChange = vi.fn()
		render(
			<TaskInput
				dispatch={vi.fn()}
				draft={{ text: "", images: [], files: [] }}
				onDraftChange={onDraftChange}
				view={resumeView()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Add attachments" }))

		await waitFor(() => expect(onDraftChange).toHaveBeenCalledWith({ text: "", images: ["image-1"], files: ["file-1"] }))
	})

	it("removes a selected attachment", () => {
		const onDraftChange = vi.fn()
		render(
			<TaskInput
				dispatch={vi.fn()}
				draft={{ text: "", images: ["image-1"], files: ["file-1"] }}
				onDraftChange={onDraftChange}
				view={resumeView()}
			/>,
		)

		fireEvent.click(screen.getByRole("button", { name: "Remove file 1" }))
		expect(onDraftChange).toHaveBeenCalledWith({ text: "", images: ["image-1"], files: [] })
	})

	it("does not render attachment selection when backend policy disallows it", () => {
		const view = resumeView()
		view.input.acceptsImages = false
		view.input.acceptsFiles = false
		render(<TaskInput dispatch={vi.fn()} draft={{ text: "", images: [], files: [] }} onDraftChange={vi.fn()} view={view} />)

		expect(screen.queryByRole("button", { name: "Add attachments" })).toBeNull()
	})

	it("defaults Enter to Reject for approval while preserving the draft", () => {
		const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
		const view = resumeView()
		if (!view.activeInteraction) {
			throw new Error("Expected active interaction")
		}
		view.activeInteraction = { ...view.activeInteraction, kind: "tool_approval", taskAsk: "tool" }
		view.input.enterAction = "reject"

		render(
			<TaskInput dispatch={dispatch} draft={{ text: "note", images: [], files: [] }} onDraftChange={vi.fn()} view={view} />,
		)
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" })

		expect(dispatch).toHaveBeenCalledWith(
			expect.objectContaining({ actionId: "reject", draft: { text: "note", images: [], files: [] } }),
		)
	})

	it("submits New Task feedback through the projected reject action on Enter", () => {
		const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
		const view = resumeView()
		if (!view.activeInteraction) {
			throw new Error("Expected active interaction")
		}
		view.activeInteraction = {
			...view.activeInteraction,
			interactionId: "new-task-1",
			kind: "new_task",
			presentationKind: "new_task",
			taskAsk: "new_task",
		}
		view.input.enterAction = "reject"
		const draft = { text: "Keep the compatibility constraints", images: ["image-1"], files: ["file-1"] }

		render(<TaskInput dispatch={dispatch} draft={draft} onDraftChange={vi.fn()} view={view} />)
		fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", code: "Enter" })

		expect(dispatch).toHaveBeenCalledWith({
			taskId: "task-1",
			taskInstanceId: "task-instance-1",
			turnId: "turn-1",
			interactionId: "new-task-1",
			actionId: "reject",
			stateRevision: 9,
			draft,
			selection: undefined,
		})
	})
})
