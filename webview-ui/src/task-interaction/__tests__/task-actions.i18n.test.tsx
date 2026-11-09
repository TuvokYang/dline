import type { TaskViewAction, TaskViewState } from "@shared/ExtensionMessage"
import type { UiLanguage } from "@shared/UiLanguage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ButtonHTMLAttributes } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { FooterActions } from "../FooterActions"
import { dispatchTaskAction } from "../task-actions"

const rpc = vi.hoisted(() => ({ stopAwayMode: vi.fn(), moveCommandToBackground: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({ TaskServiceClient: rpc }))
// Exercise the public disabled/button contract rather than unupgraded FAST internals in jsdom.
vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()),
    VSCodeButton: ({ appearance: _appearance, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }) => (
        <button {...props} />
    ),
}))

const stop: TaskViewAction = {
    type: "stop_away",
    label: "RAW host label",
    appearance: "secondary",
    enabled: true,
    dispatchTarget: "task",
    payloadPolicy: "none",
}
const background: TaskViewAction = {
    ...stop,
    type: "continue_in_background",
    activityId: "RAW-activity-id",
}
const cases = [
    {
        action: stop,
        result: "task_read_only",
        button: "Stop Away Mode",
        english: "This task is open in another window and cannot be changed here.",
        chinese: "此任务已在另一个窗口中打开，无法在此处更改。",
    },
    {
        action: stop,
        result: "refused",
        button: "Stop Away Mode",
        english: "Away Mode could not be stopped for this task opening. Reopen the task and try again.",
        chinese: "无法为当前打开的任务停止离开模式。请重新打开任务后重试。",
    },
    {
        action: background,
        result: "refused",
        button: "Continue in Background",
        english: "The foreground activity is no longer available to continue in the background.",
        chinese: "此前台活动已不可用，无法继续在后台运行。",
    },
] as const

beforeEach(() => vi.clearAllMocks())

describe("local task-action failure presentation", () => {
    it.each(cases)("retranslates $button / $result without resending or reading the composer", async ({
        action,
        result,
        button,
        english,
        chinese,
    }) => {
        rpc.stopAwayMode.mockResolvedValueOnce({ accepted: false, result })
        rpc.moveCommandToBackground.mockResolvedValueOnce({ moved: false })
        const state: TaskViewState = {
            taskId: "RAW-task-id",
            taskInstanceId: "RAW-opening-id",
            stateRevision: 12,
            phase: "streaming",
            input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
            footer: { actions: [action] },
        }
        const draft = {
            get text(): string {
                throw new Error("A task action must not read or submit the composer draft")
            },
            images: [],
            files: [],
            activeQuote: null,
        }
        const dispatch = vi.fn()
        const settled = vi.fn()
        const taskDispatch = vi.fn((selected: TaskViewAction) => dispatchTaskAction(state, selected))
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <FooterActions
                    dispatch={dispatch}
                    dispatchTaskAction={taskDispatch}
                    draft={draft}
                    onDraftAccepted={settled}
                    onDraftRejected={settled}
                    view={state}
                />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const control = screen.getByRole("button", { name: button })
        fireEvent.click(control)
        await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent(english))
        const alert = screen.getByRole("alert")
        expect(control).toBeEnabled()

        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("alert")).toBe(alert)
        expect(alert).toHaveTextContent(chinese)
        expect(screen.getByRole("button")).toBe(control)
        view.rerender(tree("en"))
        expect(screen.getByRole("alert")).toBe(alert)
        expect(alert).toHaveTextContent(english)
        expect(control).toHaveAccessibleName(button)
        expect(taskDispatch).toHaveBeenCalledExactlyOnceWith(action)
        expect(taskDispatch.mock.calls[0][0]).toBe(action)
        expect(dispatch).not.toHaveBeenCalled()
        expect(settled).not.toHaveBeenCalled()
        const identity = { taskId: "RAW-task-id", taskInstanceId: "RAW-opening-id" }
        if (action.type === "stop_away") {
            expect(rpc.stopAwayMode).toHaveBeenCalledExactlyOnceWith(identity)
            expect(rpc.moveCommandToBackground).not.toHaveBeenCalled()
        } else {
            expect(rpc.moveCommandToBackground).toHaveBeenCalledExactlyOnceWith({ ...identity, activityId: "RAW-activity-id" })
            expect(rpc.stopAwayMode).not.toHaveBeenCalled()
        }
    })
})
