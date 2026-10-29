import type { TaskViewActionType, TaskViewState, UiAsk, UiMessage } from "@shared/ExtensionMessage"
import {
    createReportBugDraft,
    type ReportBugDraft,
    reportBugDraftFromSelection,
    serializeReportBugDraft,
} from "@shared/report-bug"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ReportBugRow } from "@/components/chat/ReportBugRow"
import { TaskServiceClient } from "@/services/grpc-client"
import { InteractionHost } from "../InteractionHost"
import { InteractionSelectionProvider, useInteractionSelection } from "../interaction-selection"

vi.mock("@/services/grpc-client", () => ({
    TaskServiceClient: {
        cancelTask: vi.fn(async () => undefined),
        moveCommandToBackground: vi.fn(async () => ({ moved: true })),
    },
}))

const ASK: UiMessage = {
    ts: 100,
    type: "ask",
    ask: "tool",
    text: "Approve write",
    interactionId: "interaction-1",
}
const SAY: UiMessage = { ts: 90, type: "say", say: "text", text: "status text" }

/** Create one active interaction view anchored to timestamp 100. */
function taskView(): TaskViewState {
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
            anchorVerified: true,
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

function reportBugInteraction(): { view: TaskViewState; message: UiMessage; draft: ReportBugDraft } {
    const view = taskView()
    if (!view.activeInteraction) throw new Error("Expected active interaction")
    const draft = createReportBugDraft(
        {
            title: "Provider request failed",
            whatHappened: "The request stopped.",
            stepsToReproduce: "Send a task.",
            apiRequestOutput: "safe failure",
            additionalContext: "Review before opening.",
        },
        {
            providerAndModel: "test / model",
            operatingSystem: "test-os",
            systemInfo: "test-system",
            dlineVersion: "1.2.3",
        },
    )
    view.phase = "paused"
    view.activeInteraction = {
        ...view.activeInteraction,
        kind: "report_bug",
        taskAsk: "report_bug",
        presentationKind: "report_bug",
    }
    view.input = { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false }
    view.footer.actions = [
        {
            type: "approve",
            label: "Open GitHub Issue",
            appearance: "primary",
            enabled: true,
            payloadPolicy: "selection",
            dispatchTarget: "interaction",
        },
        {
            type: "reject",
            label: "Cancel",
            appearance: "secondary",
            enabled: true,
            payloadPolicy: "none",
            dispatchTarget: "interaction",
        },
    ]
    return {
        view,
        draft,
        message: { ...ASK, ask: "report_bug", text: serializeReportBugDraft(draft) },
    }
}

/**
 * Type into a toolkit text area as its own handler does: set the host's value, then
 * announce the input. The host's value accessor is inherited, so fireEvent cannot set it.
 */
function typeInto(box: HTMLElement, value: string) {
    ;(box as HTMLTextAreaElement).value = value
    fireEvent.input(box)
}

function configureInteraction(
    view: TaskViewState,
    input: {
        kind: string
        taskAsk: UiAsk
        presentationKind: string
        action: TaskViewActionType
        label: string
        enterAction?: TaskViewActionType
    },
): UiMessage {
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
            taskInstanceId: "task-instance-1",
            turnId: "turn-1",
            interactionId: "interaction-1",
            actionId: "approve",
            stateRevision: 8,
            draft: { text: "approval feedback", images: ["image"], files: ["file"] },
            selection: undefined,
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
        view.footer.actions = [
            {
                type: "approve",
                label: "Approve",
                appearance: "primary",
                enabled: true,
                payloadPolicy: "selection",
                dispatchTarget: "interaction",
            },
        ]
        const message: UiMessage = {
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

    it("dispatches the card's supplement and explicit consent only on Confirm", async () => {
        const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
        const report = reportBugInteraction()
        render(<InteractionHost dispatch={dispatch} messages={[report.message]} view={report.view} />)

        typeInto(screen.getByLabelText("Additional details"), "  Happens after restart.  ")
        fireEvent.click(screen.getByText("Temporarily share high-density diagnostics for this issue"))
        expect(dispatch).not.toHaveBeenCalled()

        fireEvent.click(screen.getByRole("button", { name: "Open GitHub Issue" }))

        await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
        const selection = dispatch.mock.calls[0][0].selection?.values
        const confirmed = reportBugDraftFromSelection(selection)
        expect(confirmed?.content).toEqual({
            ...report.draft.content,
            additionalContext: "Review before opening.\n\nUser supplement:\nHappens after restart.",
        })
        expect(confirmed?.temporaryTelemetryConsent).toBe(true)
        expect(confirmed?.environment).toEqual(report.draft.environment)
    })

    it("submits the prepared draft unchanged when the supplement is left blank", async () => {
        const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
        const report = reportBugInteraction()
        render(<InteractionHost dispatch={dispatch} messages={[report.message]} view={report.view} />)

        typeInto(screen.getByLabelText("Additional details"), "draft")
        typeInto(screen.getByLabelText("Additional details"), "   ")
        fireEvent.click(screen.getByRole("button", { name: "Open GitHub Issue" }))

        await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
        expect(reportBugDraftFromSelection(dispatch.mock.calls[0][0].selection?.values)).toEqual(report.draft)
    })

    it("submits from the footer the supplement typed into the chat's ReportBug row", async () => {
        const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
        const report = reportBugInteraction()
        function ChatWithFooter() {
            const selection = useInteractionSelection(report.view, report.message)
            return (
                <InteractionSelectionProvider value={selection}>
                    <ReportBugRow message={report.message} />
                    <InteractionHost
                        dispatch={dispatch}
                        messages={[SAY, report.message]}
                        selection={selection}
                        showTimeline={false}
                        view={report.view}
                    />
                </InteractionSelectionProvider>
            )
        }
        render(<ChatWithFooter />)

        // The chat row is the only editing surface; the footer draws just its actions.
        expect(screen.queryByTestId("presentation-report_bug")).toBeNull()
        const card = screen.getByTestId("report-bug-card")
        typeInto(within(card).getByLabelText("Additional details"), "Seen twice today.")
        fireEvent.click(screen.getByRole("button", { name: "Open GitHub Issue" }))

        await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
        expect(reportBugDraftFromSelection(dispatch.mock.calls[0][0].selection?.values)?.content.additionalContext).toBe(
            "Review before opening.\n\nUser supplement:\nSeen twice today.",
        )
    })

    it("draws a ReportBug row that is not the pending anchor read-only", () => {
        const report = reportBugInteraction()
        function AnsweredRow() {
            const selection = useInteractionSelection(report.view, { ...report.message, ts: 99 })
            return (
                <InteractionSelectionProvider value={selection}>
                    <ReportBugRow message={report.message} />
                </InteractionSelectionProvider>
            )
        }
        render(<AnsweredRow />)

        expect(within(screen.getByTestId("report-bug-card")).getByText("Provider request failed")).toBeVisible()
        expect(screen.queryByLabelText("Additional details")).toBeNull()
    })

    it("cancels ReportBug without carrying a draft selection", async () => {
        const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
        const report = reportBugInteraction()
        render(<InteractionHost dispatch={dispatch} messages={[report.message]} view={report.view} />)

        typeInto(screen.getByLabelText("Additional details"), "unsent edit")
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

        await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({ actionId: "reject", draft: undefined, selection: undefined }),
        )
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
                expect.objectContaining({
                    taskId: "task-1",
                    taskInstanceId: "task-instance-1",
                    activityId: "command-1",
                }),
            ),
        )
        expect(TaskServiceClient.cancelTask).not.toHaveBeenCalled()
        // Cancelling is the composer's action button's job, not the footer's.
        expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull()
    })

    it.each([
        ["timestamp", { ...ASK, ts: 101 }],
        ["missing interaction identity", { ...ASK, interactionId: undefined }],
        ["interaction identity", { ...ASK, interactionId: "interaction-2" }],
        ["task ask", { ...ASK, ask: "command" as const }],
    ])("keeps backend-verified controls available for a mismatched %s window row", (_field, message) => {
        render(<InteractionHost dispatch={vi.fn()} messages={[SAY, message]} view={taskView()} />)

        expect(screen.getByText("status text")).toBeVisible()
        expect(screen.getByRole("button", { name: "Approve" })).toBeVisible()
        expect(screen.getByRole("button", { name: "Reject" })).toBeVisible()
        expect(screen.queryByRole("alert")).toBeNull()
    })

    it("keeps backend-verified controls available while the matching window row is partial", () => {
        render(<InteractionHost dispatch={vi.fn()} messages={[SAY, { ...ASK, partial: true }]} view={taskView()} />)

        expect(screen.getByRole("button", { name: "Approve" })).toBeVisible()
        expect(screen.getByRole("button", { name: "Reject" })).toBeVisible()
        expect(screen.queryByRole("alert")).toBeNull()
    })

    it("keeps backend-verified controls available when the message window contains a duplicate", () => {
        render(<InteractionHost dispatch={vi.fn()} messages={[ASK, { ...ASK, text: "Duplicate ask" }]} view={taskView()} />)

        expect(screen.getByRole("button", { name: "Approve" })).toBeVisible()
        expect(screen.getByRole("button", { name: "Reject" })).toBeVisible()
        expect(screen.queryByRole("alert")).toBeNull()
    })

    it("dispatches the backend-verified interaction before the message window catches up", async () => {
        const dispatch = vi.fn(async () => ({ accepted: true, result: "accepted" }))
        render(<InteractionHost dispatch={dispatch} messages={[SAY]} view={taskView()} />)

        fireEvent.click(screen.getByRole("button", { name: "Approve" }))

        await waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
        expect(dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                taskId: "task-1",
                turnId: "turn-1",
                interactionId: "interaction-1",
                actionId: "approve",
                stateRevision: 8,
            }),
        )
        expect(screen.queryByRole("alert")).toBeNull()
    })

    it("renders the exact approval summary above actions in footer-only mode", () => {
        render(<InteractionHost dispatch={vi.fn()} messages={[SAY, ASK]} showTimeline={false} view={taskView()} />)

        expect(screen.getByText("Approve write")).toBeVisible()
        expect(screen.getByRole("button", { name: "Approve" })).toHaveAttribute("aria-disabled", "false")
        expect(screen.queryByRole("alert")).toBeNull()
    })

    it("hosts the pending call's own card above the actions when a card renderer is given", () => {
        const renderApprovalCard = vi.fn((message: UiMessage) => <div data-testid="hosted-card">{`card ${message.ts}`}</div>)
        render(
            <InteractionHost
                dispatch={vi.fn()}
                messages={[SAY, ASK]}
                renderApprovalCard={renderApprovalCard}
                showTimeline={false}
                view={taskView()}
            />,
        )

        const frame = screen.getByTestId("presentation-tool_approval")
        expect(within(frame).getByTestId("hosted-card")).toHaveTextContent("card 100")
        expect(renderApprovalCard).toHaveBeenCalledWith(ASK)
        expect(screen.queryByText("Approve write")).toBeNull()
        const approve = screen.getByRole("button", { name: "Approve" })
        expect(frame.compareDocumentPosition(approve) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it("keeps the focus-chain renderer, which is not a hosted card, even when a card renderer is given", () => {
        const view = taskView()
        const change = {
            ...configureInteraction(view, {
                kind: "focus_chain_change",
                taskAsk: "change_todo_list",
                presentationKind: "focus_chain_change",
                action: "approve",
                label: "Approve",
            }),
            text: JSON.stringify({ plan: "- [ ] First step", reason: "Reorder" }),
        }
        const renderApprovalCard = vi.fn(() => <div data-testid="hosted-card" />)
        render(
            <InteractionHost
                dispatch={vi.fn()}
                messages={[change]}
                renderApprovalCard={renderApprovalCard}
                showTimeline={false}
                view={view}
            />,
        )

        expect(screen.getByTestId("presentation-focus_chain_change")).toBeInTheDocument()
        expect(screen.queryByTestId("hosted-card")).toBeNull()
        expect(renderApprovalCard).not.toHaveBeenCalled()
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

    it("does not warn about anchors once the interaction is resolved", () => {
        const view = taskView()
        delete view.activeInteraction
        view.footer.actions = []

        render(<InteractionHost dispatch={vi.fn()} messages={[SAY]} view={view} />)

        expect(screen.queryByRole("alert")).toBeNull()
    })

    it("keeps task actions available while interaction controls wait for their exact anchor", async () => {
        const view = taskView()
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

        await waitFor(() => expect(TaskServiceClient.moveCommandToBackground).toHaveBeenCalledOnce())
        expect(screen.queryByRole("button", { name: "Approve" })).toBeNull()
        expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull()
    })

    it("shows the full-width Resume in the footer for a paused task, beside the composer's resume", () => {
        const view = taskView()
        const message = configureInteraction(view, {
            name: "Resume",
            label: "Resume",
            kind: "resume",
            taskAsk: "resume_task",
            presentationKind: "resume",
            action: "resume",
            enterAction: "resume",
        })
        render(<InteractionHost dispatch={vi.fn()} messages={[message]} view={view} />)

        expect(screen.getByRole("button", { name: "Resume" })).toHaveAttribute("aria-disabled", "false")
    })

    it.each([
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
