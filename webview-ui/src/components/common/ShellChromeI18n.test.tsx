import { Environment } from "@shared/config-types"
import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { type ButtonHTMLAttributes, type ReactNode, useState } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const reportWebviewError = vi.hoisted(() => vi.fn())
vi.mock("@/services/webviewErrorReporter", () => ({ reportWebviewError }))
// Exercise the toolkit button contract without FAST's inaccessible jsdom shadow tree.
vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()),
    VSCodeButton: ({ appearance: _appearance, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }) => (
        <button type="button" {...props} />
    ),
}))

import {
    ALERT_DIALOG_BACKDROP_STYLE,
    AlertDialog,
    AlertDialogContent,
    UnsavedChangesDialog,
} from "@/components/common/AlertDialog"
import BannerCarousel from "@/components/common/BannerCarousel"
import { CopyButton } from "@/components/common/CopyButton"
import { HydrationFailed, HydrationPending } from "@/components/common/HydrationGate"
import { RootErrorBoundary } from "@/components/common/RootErrorBoundary"
import ViewHeader from "@/components/common/ViewHeader"
import { translateUi } from "@/i18n/messages"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"

/** A one-word product label per language, used to prove a portalled child re-renders. */
const t = (language: UiLanguage) => translateUi(language, "shell.chrome.cancel")

function Provider({ children, language }: { children: ReactNode; language: UiLanguage }) {
    return <UiLanguageProvider language={language}>{children}</UiLanguageProvider>
}

function Switcher({ children }: { children: ReactNode }) {
    const [language, setLanguage] = useState<UiLanguage>("en")
    return (
        <UiLanguageProvider language={language}>
            <button onClick={() => setLanguage(language === "en" ? "zh-CN" : "en")} type="button">
                switch-language
            </button>
            {children}
        </UiLanguageProvider>
    )
}

function switchLanguage() {
    fireEvent.click(screen.getByRole("button", { name: "switch-language" }))
}

describe("shared shell chrome language switching", () => {
    it("translates the view header title, Done action and environment suffix", async () => {
        render(
            <Switcher>
                <ViewHeader environment={Environment.staging} onDone={vi.fn()} showEnvironmentSuffix title="History" />
            </Switcher>,
        )

        expect(screen.getByText("Staging environment")).toBeTruthy()
        const done = screen.getByRole("button", { name: "Done" })

        await act(async () => switchLanguage())

        expect(screen.getByText("预发布环境")).toBeTruthy()
        expect(screen.getByRole("button", { name: "完成" })).toBe(done)
    })

    it("keeps a caller-supplied Done label and stays reactive", () => {
        const { rerender } = render(
            <Provider language="en">
                <ViewHeader doneLabel="Close view" onDone={vi.fn()} title="Custom" />
            </Provider>,
        )
        expect(screen.getByRole("button", { name: "Close view" })).toBeTruthy()

        rerender(
            <Provider language="zh-CN">
                <ViewHeader doneLabel="关闭视图" onDone={vi.fn()} title="自定义" />
            </Provider>,
        )
        expect(screen.getByRole("button", { name: "关闭视图" })).toBeTruthy()
    })

    it("translates the hydration pending and failure wrappers but not the raw failure reason", async () => {
        render(
            <Switcher>
                <HydrationFailed onRetry={vi.fn()} reason="state stream closed (code 4001)" />
            </Switcher>,
        )

        expect(screen.getByText("Dline could not load its state.")).toBeTruthy()
        expect(screen.getByTestId("hydration-failed-reason")).toHaveTextContent("state stream closed (code 4001)")
        const retry = screen.getByRole("button", { name: "Retry" })

        await act(async () => switchLanguage())

        expect(screen.getByText("Dline 无法加载状态。")).toBeTruthy()
        expect(screen.getByTestId("hydration-failed-reason")).toHaveTextContent("state stream closed (code 4001)")
        expect(screen.getByRole("button", { name: "重试" })).toBe(retry)
    })

    it.each([
        { kind: "unknown" as const, english: "Unknown state subscription failure", chinese: "状态订阅发生未知错误" },
        {
            kind: "closed" as const,
            english: "State subscription closed before any state arrived",
            chinese: "状态订阅在收到任何状态之前已关闭",
        },
    ])("translates a product-owned hydration reason without changing retry: $kind", ({ kind, english, chinese }) => {
        const onRetry = vi.fn()
        const fallback = <HydrationFailed onRetry={onRetry} reason={{ kind }} />
        const { rerender } = render(<Provider language="en">{fallback}</Provider>)
        const reason = screen.getByTestId("hydration-failed-reason")
        const retry = screen.getByRole("button", { name: "Retry" })
        expect(reason).toHaveTextContent(english)
        rerender(<Provider language="zh-CN">{fallback}</Provider>)
        expect(screen.getByTestId("hydration-failed-reason")).toBe(reason)
        expect(reason).toHaveTextContent(chinese)
        expect(screen.getByRole("button", { name: "重试" })).toBe(retry)
        rerender(<Provider language="en">{fallback}</Provider>)
        expect(reason).toHaveTextContent(english)
        fireEvent.click(retry)
        expect(onRetry).toHaveBeenCalledTimes(1)
    })

    it("translates the pending copy without remounting the escalation", async () => {
        render(
            <Switcher>
                <HydrationPending slowThresholdMs={1_000_000} />
            </Switcher>,
        )
        const pending = screen.getByText("Loading Dline…")

        await act(async () => switchLanguage())

        expect(screen.getByText("正在加载 Dline…")).toBe(pending)
        expect(screen.queryByTestId("hydration-pending-slow")).toBeNull()
    })

    it("translates the unsaved-changes dialog and preserves its save action", async () => {
        const onSave = vi.fn()
        render(
            <Switcher>
                <UnsavedChangesDialog
                    onCancel={vi.fn()}
                    onConfirm={vi.fn()}
                    onOpenChange={vi.fn()}
                    onSave={onSave}
                    open
                    showSaveOption
                />
            </Switcher>,
        )

        expect(screen.getByRole("heading", { name: /Unsaved Changes/ })).toBeTruthy()
        const save = screen.getByRole("button", { name: "Save & Continue" })

        await act(async () => switchLanguage())

        expect(screen.getByRole("heading", { name: /未保存的更改/ })).toBeTruthy()
        expect(screen.getByRole("button", { name: "取消" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "保存并继续" })).toBe(save)
        expect(screen.getByRole("button", { name: "放弃更改" })).toBeTruthy()
        fireEvent.click(save)
        expect(onSave).toHaveBeenCalledTimes(1)
    })

    it("keeps the body-level portal and backdrop while its children re-render in the new language", () => {
        const { rerender } = render(
            <Provider language="en">
                <AlertDialog onOpenChange={vi.fn()} open>
                    <AlertDialogContent>{t("en")}</AlertDialogContent>
                </AlertDialog>
            </Provider>,
        )
        expect(ALERT_DIALOG_BACKDROP_STYLE.backgroundColor).toBe("rgba(96, 96, 96, 0.42)")
        expect(screen.getByRole("dialog")).toBeTruthy()
        expect(screen.getByText("Cancel")).toBeTruthy()

        rerender(
            <Provider language="zh-CN">
                <AlertDialog onOpenChange={vi.fn()} open>
                    <AlertDialogContent>{t("zh-CN")}</AlertDialogContent>
                </AlertDialog>
            </Provider>,
        )
        // The dialog stays portalled on document.body; only its content changes.
        expect(document.body.contains(screen.getByRole("dialog"))).toBe(true)
        expect(screen.getByText("取消")).toBeTruthy()
    })

    it("translates the carousel region, dismissal and navigation controls", async () => {
        const onDismiss = vi.fn()
        render(
            <Switcher>
                <BannerCarousel
                    banners={[
                        { id: "a", title: "First", description: "One", onDismiss },
                        { id: "b", title: "Second", description: "Two", onDismiss },
                    ]}
                />
            </Switcher>,
        )

        expect(screen.getByRole("region", { name: "Announcements" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "Dismiss banner" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "Previous banner" })).toBeTruthy()

        await act(async () => switchLanguage())

        expect(screen.getByRole("region", { name: "公告" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "关闭横幅" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "上一条横幅" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "下一条横幅" })).toBeTruthy()
        // Banner titles come from the feature that raised them and are not translated here.
        expect(screen.getByText("First")).toBeTruthy()
    })

    it("translates the copy button state after copying", async () => {
        const writeText = vi.fn(async () => undefined)
        render(
            <Switcher>
                <CopyButton textToCopy="payload" writeText={writeText} />
            </Switcher>,
        )

        expect(screen.getByRole("button", { name: "Copy" })).toBeTruthy()
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Copy" }))
        })
        expect(writeText).toHaveBeenCalledWith("payload")
        expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy()

        await act(async () => switchLanguage())
        expect(screen.getByRole("button", { name: "已复制" })).toBeTruthy()
    })
})

describe("RootErrorBoundary fallback language", () => {
    const Thrower = () => {
        throw new Error("render exploded")
    }

    beforeEach(() => {
        reportWebviewError.mockReset()
        vi.spyOn(console, "error").mockImplementation(() => undefined)
        document.documentElement.lang = ""
    })

    afterEach(() => {
        vi.restoreAllMocks()
        document.documentElement.lang = ""
    })

    it("stays usable outside the Provider and renders the English baseline before hydration", () => {
        render(
            <RootErrorBoundary>
                <Thrower />
            </RootErrorBoundary>,
        )

        // No Provider wraps the boundary and no language has been projected yet.
        expect(screen.getByText("Dline hit an error while rendering this panel.")).toBeTruthy()
        expect(screen.getByRole("button", { name: "Reload panel" })).toBeTruthy()
        expect(screen.getByTestId("root-error-message")).toHaveTextContent("render exploded")
        expect(reportWebviewError).toHaveBeenCalledTimes(1)
    })

    it("follows the language the root has already projected onto the document", () => {
        document.documentElement.lang = "zh-CN"
        render(
            <RootErrorBoundary>
                <Thrower />
            </RootErrorBoundary>,
        )

        expect(screen.getByText("Dline 渲染此面板时遇到错误。")).toBeTruthy()
        expect(screen.getByRole("button", { name: "重新加载面板" })).toBeTruthy()
    })

    it("falls back to English for an unrecognised projected language", () => {
        document.documentElement.lang = "fr"
        render(
            <RootErrorBoundary>
                <Thrower />
            </RootErrorBoundary>,
        )

        expect(screen.getByText("Dline hit an error while rendering this panel.")).toBeTruthy()
    })
})
