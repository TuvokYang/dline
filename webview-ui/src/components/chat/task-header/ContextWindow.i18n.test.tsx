import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import type { UiLanguage } from "@shared/UiLanguage"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ButtonHTMLAttributes } from "react"
import { describe, expect, it, vi } from "vitest"
import { UiLanguageProvider, useUiTranslation } from "@/i18n/UiLanguageProvider"
import ContextWindow from "./ContextWindow"
import { createContextWindowIndicatorViewModel } from "./ContextWindowIndicatorViewModel"
import ContextWindowSegmentedProgress from "./ContextWindowSegmentedProgress"
import { ContextWindowSummary } from "./ContextWindowSummary"

// Exercise the public toolkit button contract, not FAST's unregistered jsdom internals.
vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()),
    VSCodeButton: ({ appearance: _appearance, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }) => (
        <button {...props} />
    ),
}))

const SNAPSHOT: ContextWindowIndicatorSnapshot = {
    taskId: "task-stable-id",
    revision: 7,
    epoch: 2,
    phase: "receiving",
    mode: "act",
    updatedAt: 100,
    durableContextTokens: 1000,
    pendingSendTokens: 0,
    receivingTokens: 200,
    stagedTokens: 30,
    environmentTokens: 40,
    contextWindow: 10000,
    lineage: { kind: "baseline" },
}

function Indicator({ snapshot }: { snapshot: ContextWindowIndicatorSnapshot }) {
    const { t } = useUiTranslation()
    const viewModel = createContextWindowIndicatorViewModel(snapshot, {}, t)
    return (
        <>
            <ContextWindowSegmentedProgress snapshot={snapshot} />
            <ContextWindowSummary
                contextWindow={viewModel.contextWindow}
                indicatorViewModel={viewModel}
                percentage={viewModel.percentage}
                tokenUsed={viewModel.totalTokens}
            />
        </>
    )
}

describe("context presentation language and semantics", () => {
    it("updates memoized labels and preserves expanded state; receiving/sending colors follow activity rather than a label", () => {
        const tree = (language: UiLanguage, snapshot = SNAPSHOT) => (
            <UiLanguageProvider language={language}>
                <Indicator snapshot={snapshot} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const active = screen.getByTestId("context-window-segment-active")
        const detail = document.querySelector<HTMLElement>('[data-segment-detail="active"]')
        const color = () => active.style.backgroundColor
        const receivingColor = color()
        expect(receivingColor).toContain("yellow")
        expect(detail?.style.backgroundColor).toBe(receivingColor)
        fireEvent.click(screen.getByRole("button", { name: /Durable/ }))
        const breakdown = screen.getByTestId("context-window-durable-breakdown")
        view.rerender(tree("zh-CN"))
        expect(active).toHaveAccessibleName("接收中：200 个 token")
        expect(screen.getByRole("progressbar")).toHaveAttribute("aria-valuetext", "已用 1270 / 10000 个 token；阶段：接收中")
        expect(screen.getByRole("button", { name: /持久上下文/ })).toHaveAttribute("aria-expanded", "true")
        expect(screen.getByTestId("context-window-durable-breakdown")).toBe(breakdown)
        expect(color()).toBe(receivingColor)
        expect(detail?.style.backgroundColor).toBe(receivingColor)
        expect(active).toHaveAttribute("data-authoritative-tokens", "200")
        view.rerender(tree("en"))
        expect(active).toHaveAccessibleName("Receiving: 200 tokens")
        expect(color()).toBe(receivingColor)
        view.rerender(tree("zh-CN", { ...SNAPSHOT, phase: "sending", pendingSendTokens: 200, receivingTokens: 0 }))
        expect(active).toHaveAccessibleName("发送中：200 个 token")
        expect(color()).toContain("blue")
        expect(color()).not.toBe(receivingColor)
        expect(detail?.style.backgroundColor).toBe(color())
    })

    it("switches an open destructive portal without resetting its exact confirmation input or dispatching on translation", async () => {
        const truncate = vi.fn(async () => true)
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <ContextWindow
                    contextWindowIndicator={SNAPSHOT}
                    forceTruncateAvailable
                    onForceTruncateTask={truncate}
                    useAutoCondense={false}
                />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        fireEvent.click(screen.getByRole("button", { name: "More context actions" }))
        fireEvent.click(screen.getByRole("button", { name: "Force truncate conversation history" }))
        const input = screen.getByLabelText("Type TRUNCATE to confirm")
        fireEvent.change(input, { target: { value: "TRUNC" } })
        const dialog = screen.getByRole("dialog")
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("dialog")).toBe(dialog)
        expect(screen.getByLabelText("输入 TRUNCATE 以确认")).toBe(input)
        expect(input).toHaveValue("TRUNC")
        const confirm = screen.getByText("强制截断对话历史", { exact: true })
        expect(confirm).toBeDisabled()
        expect(dialog.querySelector("code")).toHaveTextContent("TRUNCATE")
        expect(truncate).not.toHaveBeenCalled()
        view.rerender(tree("en"))
        expect(input).toHaveValue("TRUNC")
        fireEvent.change(input, { target: { value: "TRUNCATE" } })
        expect(screen.getByText("Force truncate conversation history", { exact: true })).toBe(confirm)
        expect(confirm).toBeEnabled()
        fireEvent.click(confirm)
        await waitFor(() => expect(truncate).toHaveBeenCalledOnce())
    })
})
