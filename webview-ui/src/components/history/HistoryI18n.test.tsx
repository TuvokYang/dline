import type { HistoryItem } from "@shared/HistoryItem"
import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, useState } from "react"
import { VirtuosoMockContext } from "react-virtuoso"
import { beforeEach, describe, expect, it, vi } from "vitest"

const extensionState = vi.hoisted(() => ({
    openHistoryTask: vi.fn(),
    taskHistory: [] as HistoryItem[],
    workspaceRoots: [{ path: "C:\\work\\current", name: "current" }],
    historyTaskOpening: undefined,
    onRelinquishControl: () => () => {},
    environment: "production",
    totalTasksSize: null as number | null,
    setTotalTasksSize: vi.fn(),
}))

vi.mock("@vscode/webview-ui-toolkit/react", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@vscode/webview-ui-toolkit/react")>()),
    VSCodeTextField: ({ children, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
        <div>
            <input {...props} />
            {children}
        </div>
    ),
    VSCodeButton: ({ appearance: _appearance, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }) => (
        <button type="button" {...props} />
    ),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => extensionState,
}))
vi.mock("@/services/grpc-client", () => ({
    TaskServiceClient: {
        deleteTasksWithIds: vi.fn(),
        deleteAllTaskHistory: vi.fn(),
        exportTaskWithId: vi.fn(),
        getTaskHistory: vi.fn(async () => ({ tasks: extensionState.taskHistory, totalCount: extensionState.taskHistory.length })),
        getTotalTasksSize: vi.fn().mockResolvedValue({ value: 0 }),
        openTaskInNewWindow: vi.fn(),
    },
}))

import HistoryPreview, { filterHistoryPreview, formatHistoryTimestamp } from "@/components/history/HistoryPreview"
import HistoryView from "@/components/history/HistoryView"
import HistoryViewItem from "@/components/history/HistoryViewItem"
import { TaskCompletionBadge } from "@/components/history/TaskCompletionBadge"
import { getTaskUsageLabel } from "@/components/history/task-metrics"
import { translateUi, type UiTranslator } from "@/i18n/messages"
import { UiDocumentLanguage, UiLanguageProvider } from "@/i18n/UiLanguageProvider"

function Switcher({ children }: { children: ReactNode }) {
    const [language, setLanguage] = useState<UiLanguage>("en")
    return (
        <UiLanguageProvider language={language}>
            <UiDocumentLanguage />
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

function historyItem(id: string, overrides: Partial<HistoryItem> = {}): HistoryItem {
    return {
        id,
        task: `Task ${id}`,
        ts: new Date(2026, 0, 1, 2, 3, 4).getTime(),
        size: 1024,
        tokensIn: 0,
        tokensOut: 0,
        totalCost: 0,
        cwdOnTaskInitialization: "C:\\work\\current",
        ...overrides,
    }
}

describe("history language switching", () => {
    beforeEach(() => {
        extensionState.taskHistory = []
        extensionState.workspaceRoots = [{ path: "C:\\work\\current", name: "current" }]
        vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(240)
    })

    it("updates the Recent preview labels, ARIA and filter group in both directions", async () => {
        extensionState.taskHistory = [historyItem("workspace")]
        render(
            <Switcher>
                <HistoryPreview showHistoryView={vi.fn()} />
            </Switcher>,
        )

        const recent = screen.getByText("Recent")
        expect(screen.getByRole("group", { name: "Recent task filter" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-pressed", "true")
        expect(screen.getByRole("button", { name: "View All" })).toBeTruthy()

        await act(async () => switchLanguage())

        expect(screen.getByText("最近")).toBe(recent)
        expect(screen.getByRole("group", { name: "最近任务筛选" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "工作区" })).toHaveAttribute("aria-pressed", "true")
        expect(screen.getByRole("button", { name: "查看全部" })).toBeTruthy()

        await act(async () => switchLanguage())
        expect(screen.getByText("Recent")).toBe(recent)
    })

    it("keeps the user's task title, timestamp and cost identical while translating their wrappers", async () => {
        const title = "Investigate delete behavior"
        extensionState.taskHistory = [historyItem("workspace", { task: title, totalCost: 22.588, currency: "USD" })]
        render(
            <Switcher>
                <HistoryPreview showHistoryView={vi.fn()} />
            </Switcher>,
        )

        expect(await screen.findByText(title)).toBeInTheDocument()
        expect(screen.getByText("$22.59")).toBeInTheDocument()
        expect(screen.getByText("2026/01/01 02:03:04")).toBeInTheDocument()
        expect(screen.getByTitle("Last edited 2026/01/01 02:03:04")).toBeTruthy()

        await act(async () => switchLanguage())

        // The row keeps the same data: only the title attribute and the chrome change.
        expect(screen.getByText(title)).toBeInTheDocument()
        expect(screen.getByText("$22.59")).toBeInTheDocument()
        expect(screen.getByText("2026/01/01 02:03:04")).toBeInTheDocument()
        expect(screen.getByTitle("最后编辑于 2026/01/01 02:03:04")).toBeTruthy()
    })

    it("translates the History view search, sort options and destructive actions", async () => {
        render(
            <Switcher>
                <HistoryView onDone={vi.fn()} />
            </Switcher>,
        )

        const doneButton = screen.getByRole("button", { name: "Done" })
        expect(screen.getByPlaceholderText("Fuzzy search history...")).toBeTruthy()
        expect(screen.getByRole("button", { name: "Select All" })).toBeTruthy()

        await act(async () => switchLanguage())

        expect(screen.getByRole("button", { name: "完成" })).toBe(doneButton)
        expect(screen.getByPlaceholderText("模糊搜索历史…")).toBeTruthy()
        expect(screen.getByRole("button", { name: "全选" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "取消全选" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "删除全部历史" })).toBeTruthy()
        expect(screen.getByRole("heading", { name: "历史" })).toBeTruthy()
    })

    it("keeps a no-match search editable when switching to relevance sorting and back", async () => {
        extensionState.taskHistory = [historyItem("visible", { task: "Existing task title" })]
        render(
            <Switcher>
                <VirtuosoMockContext.Provider value={{ viewportHeight: 300, itemHeight: 50 }}>
                    <HistoryView onDone={vi.fn()} />
                </VirtuosoMockContext.Provider>
            </Switcher>,
        )
        expect(await screen.findByText("Existing task title")).toBeVisible()
        const search = screen.getByRole("textbox", { name: "Fuzzy search history..." })
        await act(async () => fireEvent.input(search, { target: { value: "zzzzzzzzzzzzzzzzz" } }))
        expect(screen.getByRole("textbox", { name: "Fuzzy search history..." })).toBe(search)
        expect(search).toHaveValue("zzzzzzzzzzzzzzzzz")
        await act(async () => switchLanguage())
        expect(screen.getByRole("textbox", { name: "模糊搜索历史…" })).toBe(search)
        expect(search).toHaveValue("zzzzzzzzzzzzzzzzz")
        await act(async () => fireEvent.input(search, { target: { value: "" } }))
        expect(search).toHaveValue("")
    })

    it("keeps every per-row action reachable by its translated accessible name", async () => {
        render(
            <Switcher>
                <HistoryViewItem
                    handleDeleteHistoryItem={vi.fn()}
                    handleHistorySelect={vi.fn()}
                    index={0}
                    item={historyItem("row", { completionStateRevision: 1, isCompleted: true })}
                    pendingFavoriteToggles={{}}
                    selectedItems={[]}
                    toggleFavorite={vi.fn()}
                />
            </Switcher>,
        )

        expect(screen.getByRole("button", { name: "Open Task" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "Delete" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "Add to favorites" })).toBeTruthy()
        expect(screen.getByLabelText("Completed")).toBeTruthy()

        await act(async () => switchLanguage())

        expect(screen.getByRole("button", { name: "打开任务" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "删除" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "加入收藏" })).toBeTruthy()
        expect(screen.getByRole("button", { name: "在新窗口打开" })).toBeTruthy()
        expect(screen.getByLabelText("已完成")).toBeTruthy()
    })

    it("keeps the expanded details labels translated without changing the reported values", async () => {
        render(
            <Switcher>
                <HistoryViewItem
                    handleDeleteHistoryItem={vi.fn()}
                    handleHistorySelect={vi.fn()}
                    index={0}
                    item={historyItem("row", { modelId: "claude-sonnet-4-6", tokensIn: 1200, tokensOut: 340 })}
                    pendingFavoriteToggles={{}}
                    selectedItems={[]}
                    toggleFavorite={vi.fn()}
                />
            </Switcher>,
        )

        fireEvent.click(screen.getByText("1.5k tokens"))

        expect(screen.getByText("Model:")).toBeTruthy()
        expect(screen.getByText("Size:")).toBeTruthy()
        expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy()
        const size = screen.getByText("1.02 kB")

        act(() => switchLanguage())

        expect(screen.getByText("Token：")).toBeTruthy()
        expect(screen.getByText("模型：")).toBeTruthy()
        expect(screen.getByText("大小：")).toBeTruthy()
        // The model identifier and the byte count are data, so they do not change.
        expect(screen.getByText("claude-sonnet-4-6")).toBeTruthy()
        expect(screen.getByText("1.02 kB")).toBe(size)
    })

    it("renders the completion badge tooltip through the portal in the active language", () => {
        const { rerender } = render(
            <UiLanguageProvider language="en">
                <TaskCompletionBadge />
            </UiLanguageProvider>,
        )
        expect(screen.getByLabelText("Completed")).toBeTruthy()

        rerender(
            <UiLanguageProvider language="zh-CN">
                <TaskCompletionBadge />
            </UiLanguageProvider>,
        )
        expect(screen.getByLabelText("已完成")).toBeTruthy()
    })
})

describe("task-metrics presenter", () => {
    const english: UiTranslator = (key, ...args) => translateUi("en", key, ...args)
    const chinese: UiTranslator = (key, ...args) => translateUi("zh-CN", key, ...args)

    it("takes an explicit translator so a pure presenter does not freeze a language", () => {
        expect(getTaskUsageLabel({ tokensIn: 900, tokensOut: 400 }, 2, english)?.text).toBe("1.3k tokens")
        expect(getTaskUsageLabel({ tokensIn: 900, tokensOut: 400 }, 2, chinese)?.text).toBe("1.3k Token")
        expect(getTaskUsageLabel({ totalCost: 0, tokensIn: 900, tokensOut: 400 }, 2, chinese)?.title).toBe("Token 总数：1,300")
    })

    it("keeps currency, precision and the zero-cost rule independent of the language", () => {
        expect(getTaskUsageLabel({ totalCost: 22.588, currency: "USD" }, 2, chinese)).toMatchObject({
            kind: "cost",
            text: "$22.59",
        })
        expect(getTaskUsageLabel({ totalCost: 3.5, currency: "CNY" }, 2, chinese)).toMatchObject({
            kind: "cost",
            text: "¥3.50",
        })
        expect(getTaskUsageLabel({ totalCost: 1.23456, currency: "USD" }, 4, chinese)).toMatchObject({ text: "$1.2346" })
        expect(getTaskUsageLabel({ totalCost: 0 }, 2, chinese)).toBeUndefined()
    })

    it("keeps filtering and timestamp formatting data-only", () => {
        expect(formatHistoryTimestamp(new Date(2026, 0, 1, 2, 3, 4).getTime())).toBe("2026/01/01 02:03:04")
        expect(filterHistoryPreview([historyItem("a")], "workspace", ["c:/work/current"])).toHaveLength(1)
    })
})
