import type { TaskViewState } from "@shared/ExtensionMessage"
import type { DispatchInteractionResponse } from "@shared/proto/dline/task"
import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ButtonHTMLAttributes } from "react"
import { describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { FooterActions } from "../FooterActions"
import { InteractionDeadline } from "../InteractionDeadline"
import { CommandRenderer } from "../renderers/PresentationRenderers"

// jsdom does not upgrade FAST custom elements; model its public disabled/button contract explicitly.
vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()),
    VSCodeButton: ({ appearance: _appearance, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }) => (
        <button {...props} />
    ),
}))

const VIEW: TaskViewState = {
    taskId: "task-id",
    taskInstanceId: "opening-id",
    stateRevision: 12,
    phase: "awaiting_approval",
    activeInteraction: {
        taskId: "task-id",
        turnId: "turn-id",
        interactionId: "interaction-id",
        stateRevision: 12,
        kind: "command_approval",
        taskAsk: "command",
        presentationKind: "command_approval",
        askMessageTs: 10,
        status: "awaiting",
    },
    input: { enabled: true, acceptsText: true, acceptsImages: true, acceptsFiles: true },
    footer: {
        actions: [
            {
                type: "approve",
                label: "NOT the button's identity",
                appearance: "primary",
                enabled: true,
                payloadPolicy: "draft_and_selection",
                dispatchTarget: "interaction",
            },
        ],
    },
}

const DRAFT = {
    text: "Original Receiving 用户消息 /cancel",
    images: ["data:image/png;base64,RAW"],
    files: ["C:\\RAW\\name.txt"],
    activeQuote: "Original model quote",
}

function deferred() {
    let resolve!: (response: DispatchInteractionResponse) => void
    const promise = new Promise<DispatchInteractionResponse>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}

describe("interaction language isolation", () => {
    it("keeps pending scope, original payload and action identity through bidirectional switching and retranslates an existing rejection", async () => {
        const pending = deferred()
        const dispatch = vi.fn(() => pending.promise)
        const accepted = vi.fn()
        const rejected = vi.fn()
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <FooterActions
                    dispatch={dispatch}
                    draft={DRAFT}
                    onDraftAccepted={accepted}
                    onDraftRejected={rejected}
                    selection={{ values: ["raw-choice"] }}
                    view={VIEW}
                />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const approve = screen.getByRole("button", { name: "Approve" })
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("button", { name: "批准" })).toBe(approve)
        expect(dispatch).not.toHaveBeenCalled()
        fireEvent.click(approve)
        expect(dispatch).toHaveBeenCalledWith({
            taskId: "task-id",
            taskInstanceId: "opening-id",
            turnId: "turn-id",
            interactionId: "interaction-id",
            actionId: "approve",
            stateRevision: 12,
            draft: { text: DRAFT.text, images: DRAFT.images, files: DRAFT.files },
            selection: { values: ["raw-choice"] },
        })
        expect(approve).toHaveAttribute("aria-disabled", "true")
        expect(approve).toBeDisabled()
        view.rerender(tree("en"))
        expect(screen.getByRole("button", { name: "Approve" })).toBe(approve)
        expect(approve).toHaveAttribute("aria-disabled", "true")
        expect(approve).toBeDisabled()
        fireEvent.click(approve)
        expect(dispatch).toHaveBeenCalledOnce()
        await act(async () => pending.resolve({ accepted: false, result: "invalid_payload" }))
        await waitFor(() => expect(approve).toHaveAttribute("aria-disabled", "false"))
        expect(approve).toBeEnabled()
        const alert = screen.getByRole("alert")
        expect(alert).toHaveTextContent("This response could not be read.")
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("alert")).toBe(alert)
        expect(alert).toHaveTextContent("无法读取此回复")
        expect(accepted).toHaveBeenCalledOnce()
        expect(rejected).toHaveBeenCalledWith(
            expect.objectContaining({ interactionId: "interaction-id", draft: expect.objectContaining(DRAFT) }),
        )
        expect(dispatch).toHaveBeenCalledOnce()
    })

    it("translates approval and countdown wrappers while command bytes and time stay unchanged", () => {
        vi.spyOn(Date, "now").mockReturnValue(1000)
        const message = {
            ts: 10,
            type: "ask" as const,
            ask: "command" as const,
            text: "echo Receiving 用户正文",
            command: "echo Receiving 用户正文",
        }
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <CommandRenderer message={message} onSelectionChange={() => undefined} selection={[]} />
                <InteractionDeadline deadline={{ kind: "ask", deadlineAt: 62000 }} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        expect(screen.getByText("echo Receiving 用户正文")).toBeInTheDocument()
        expect(screen.getByRole("timer")).toHaveTextContent("Automatic Away Mode: 1:01")
        view.rerender(tree("zh-CN"))
        expect(screen.getByText("Dline 想要执行此命令：")).toBeInTheDocument()
        expect(screen.getByText("echo Receiving 用户正文")).toBeInTheDocument()
        expect(screen.getByRole("timer")).toHaveTextContent("自动离开模式：1:01")
        view.rerender(tree("en"))
        expect(screen.getByText("Dline wants to execute this command:")).toBeInTheDocument()
        expect(screen.getByText("echo Receiving 用户正文")).toBeInTheDocument()
        vi.restoreAllMocks()
    })
})
