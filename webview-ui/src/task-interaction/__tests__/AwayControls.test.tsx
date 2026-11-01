import type { TaskViewState } from "@shared/ExtensionMessage"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TaskServiceClient } from "@/services/grpc-client"
import { InteractionHost } from "../InteractionHost"

vi.mock("@/services/grpc-client", () => ({
    TaskServiceClient: {
        stopAwayMode: vi.fn(),
        cancelTask: vi.fn(),
        askResponse: vi.fn(),
        moveCommandToBackground: vi.fn(),
    },
}))

function view(): TaskViewState {
    return {
        taskId: "task-1",
        taskInstanceId: "opening-1",
        stateRevision: 10,
        phase: "streaming",
        away: { source: "command" },
        input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
        footer: {
            actions: [
                {
                    type: "stop_away",
                    label: "Stop Away Mode",
                    enabled: true,
                    appearance: "secondary",
                    payloadPolicy: "none",
                    dispatchTarget: "task",
                },
            ],
        },
    }
}
const emptyDraft = { text: "", images: [], files: [], activeQuote: null }
beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(TaskServiceClient.stopAwayMode).mockResolvedValue({ accepted: true, result: "accepted" })
})
afterEach(() => vi.useRealTimers())

describe("Away footer controls", () => {
    it("dispatches without touching any draft, remains until backend confirmation, and never cancels or resumes", async () => {
        let release!: (value: { accepted: boolean; result: string }) => void
        vi.mocked(TaskServiceClient.stopAwayMode).mockImplementation(
            () =>
                new Promise((resolve) => {
                    release = resolve
                }),
        )
        // Any capture of the draft is a defect, even if it is never sent.
        const draft = {
            get text(): string {
                throw new Error("Stop read composer draft")
            },
            images: [],
            files: [],
            activeQuote: null,
        }
        const dispatch = vi.fn()
        const settled = vi.fn()
        const initial = view()
        const props = { messages: [], dispatch, draft, onDraftAccepted: settled, onDraftRejected: settled }
        const rendered = render(<InteractionHost {...props} view={initial} />)
        fireEvent.click(screen.getByRole("button", { name: "Stop Away Mode" }))
        await waitFor(() =>
            expect(TaskServiceClient.stopAwayMode).toHaveBeenCalledWith({ taskId: "task-1", taskInstanceId: "opening-1" }),
        )
        expect(screen.getByRole("button", { name: "Stop Away Mode" })).toHaveAttribute("aria-disabled", "true")
        await act(async () => {
            release({ accepted: true, result: "accepted" })
        })
        expect(screen.getByRole("button", { name: "Stop Away Mode" })).toBeInTheDocument()
        rendered.rerender(
            <InteractionHost {...props} view={{ ...initial, stateRevision: 11, away: undefined, footer: { actions: [] } }} />,
        )
        expect(screen.queryByRole("button", { name: "Stop Away Mode" })).toBeNull()
        expect(dispatch).not.toHaveBeenCalled()
        expect(settled).not.toHaveBeenCalled()
        expect(TaskServiceClient.cancelTask).not.toHaveBeenCalled()
        expect(TaskServiceClient.askResponse).not.toHaveBeenCalled()
    })

    it("keeps failure retryable and disables the read-only control", async () => {
        vi.mocked(TaskServiceClient.stopAwayMode).mockRejectedValueOnce(new Error("Vault unavailable"))
        const initial = view()
        const props = { messages: [], dispatch: vi.fn(), draft: emptyDraft }
        const rendered = render(<InteractionHost {...props} view={initial} />)
        fireEvent.click(screen.getByRole("button", { name: "Stop Away Mode" }))
        await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument())
        expect(screen.getByRole("button", { name: "Stop Away Mode" })).toHaveAttribute("aria-disabled", "false")
        fireEvent.click(screen.getByRole("button", { name: "Stop Away Mode" }))
        await waitFor(() => expect(TaskServiceClient.stopAwayMode).toHaveBeenCalledTimes(2))
        rendered.rerender(
            <InteractionHost
                {...props}
                view={{ ...initial, footer: { actions: initial.footer.actions.map((a) => ({ ...a, enabled: false })) } }}
            />,
        )
        expect(screen.getByRole("button", { name: "Stop Away Mode" })).toHaveAttribute("aria-disabled", "true")
    })

    it.each(["resume", "tool_approval"] as const)("keeps Stop beside %s and leaves its answer untouched", async (kind) => {
        const initial = view()
        initial.activeInteraction = {
            taskId: "task-1",
            turnId: "turn-1",
            interactionId: "dialog",
            stateRevision: 10,
            kind,
            status: "awaiting",
            taskAsk: kind === "resume" ? "resume_task" : "tool",
            presentationKind: kind,
            askMessageTs: 50,
            anchorVerified: true,
        }
        initial.footer.actions.unshift(
            ...(kind === "resume"
                ? [{ type: "resume" as const, label: "Resume" }]
                : [
                      { type: "approve" as const, label: "Approve" },
                      { type: "reject" as const, label: "Reject" },
                  ]
            ).map((action) => ({
                ...action,
                enabled: true,
                appearance: "primary" as const,
                payloadPolicy: "draft" as const,
                dispatchTarget: "interaction" as const,
            })),
        )
        const dispatch = vi.fn()
        render(<InteractionHost dispatch={dispatch} draft={emptyDraft} messages={[]} view={initial} />)
        expect(screen.getByRole("button", { name: kind === "resume" ? "Resume" : "Approve", exact: true })).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "Stop Away Mode" }))
        await waitFor(() => expect(TaskServiceClient.stopAwayMode).toHaveBeenCalledTimes(1))
        expect(dispatch).not.toHaveBeenCalled()
    })

    it("does not transfer pending or a late error to a new opening", async () => {
        let reject!: (error: Error) => void
        vi.mocked(TaskServiceClient.stopAwayMode).mockImplementationOnce(
            () =>
                new Promise((_resolve, failure) => {
                    reject = failure
                }),
        )
        const initial = view()
        const props = { messages: [], dispatch: vi.fn(), draft: emptyDraft }
        const rendered = render(<InteractionHost {...props} view={initial} />)
        fireEvent.click(screen.getByRole("button", { name: "Stop Away Mode" }))
        const next = { ...initial, taskInstanceId: "opening-2" }
        rendered.rerender(<InteractionHost {...props} view={next} />)
        expect(screen.getByRole("button", { name: "Stop Away Mode" })).toHaveAttribute("aria-disabled", "false")
        await act(async () => reject(new Error("Old opening failed")))
        expect(screen.queryByRole("alert")).toBeNull()
        fireEvent.click(screen.getByRole("button", { name: "Stop Away Mode" }))
        await waitFor(() =>
            expect(TaskServiceClient.stopAwayMode).toHaveBeenLastCalledWith({ taskId: "task-1", taskInstanceId: "opening-2" }),
        )
    })

    it.each(["ask", "external_command"] as const)("keeps the %s deadline display-only at zero", async (kind) => {
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        const initial = view()
        initial.activeInteraction = {
            taskId: "task-1",
            turnId: "turn-1",
            interactionId: "question",
            stateRevision: 10,
            kind: "followup",
            status: "awaiting",
            taskAsk: "followup",
            presentationKind: "followup",
            askMessageTs: 5,
            anchorVerified: true,
            deadline: { kind, deadlineAt: 4000 },
        }
        const dispatch = vi.fn()
        const rendered = render(<InteractionHost dispatch={dispatch} draft={emptyDraft} messages={[]} view={initial} />)
        expect(screen.getByRole("timer")).toHaveTextContent("0:03")
        await act(async () => {
            await vi.advanceTimersByTimeAsync(10000)
        })
        expect(screen.getByRole("timer")).toHaveTextContent("0:00")
        expect(dispatch).not.toHaveBeenCalled()
        expect(TaskServiceClient.stopAwayMode).not.toHaveBeenCalled()
        expect(TaskServiceClient.askResponse).not.toHaveBeenCalled()
        rendered.rerender(
            <InteractionHost
                dispatch={dispatch}
                draft={emptyDraft}
                messages={[]}
                view={{ ...initial, activeInteraction: undefined }}
            />,
        )
        expect(screen.queryByRole("timer")).toBeNull()
    })
})
