import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { translateUi, type UiTranslator } from "@/i18n/messages"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import AgentUpdateRow from "../AgentUpdateRow"
import { ApiErrorBox } from "../ApiErrorBox"
import { SubagentRuntimeConfig } from "../activity/SubagentRuntimeConfig"
import {
    browserSessionPhaseLabel,
    describeBrowserAction,
    describeBrowserMessage,
    projectBrowserSession,
    summarizeBrowserSession,
} from "../browser-session/browser-session-model"
import { CommandOutputContent, getCommandStatusKey } from "../CommandOutputRow"
import { compactionFailureKey, describeCompactionFailure } from "../compaction-failure-label"
import { EditResultRow } from "../EditResultRow"
import { ErrorBlockTitle } from "../ErrorBlockTitle"
import ErrorRow from "../ErrorRow"
import { FeatureTip } from "../FeatureTip"
import HookMessage from "../HookMessage"
import { KillCommandRowView } from "../KillCommandRow"

const zh: UiTranslator = (key, ...args) => translateUi("zh-CN", key, ...args)
const enTranslator: UiTranslator = (key, ...args) => translateUi("en", key, ...args)

vi.mock("@/services/grpc-client", () => ({
    AccountServiceClient: { getRedirectUrl: vi.fn(async () => ({ value: "https://app.dline.cc/cb" })) },
    CheckpointsServiceClient: { checkpointRestore: vi.fn(async () => undefined) },
    FileServiceClient: {
        copyToClipboard: vi.fn(async () => undefined),
        openFileRelativePath: vi.fn(async () => undefined),
        openFile: vi.fn(async () => undefined),
    },
    TaskServiceClient: { cancelTask: vi.fn(async () => undefined) },
    UiServiceClient: { openUrl: vi.fn(async () => undefined) },
}))

vi.mock("@/context/ClineAuthContext", () => ({ useClineAuth: () => ({ activeOrganization: undefined }) }))
vi.mock("@/task-interaction/interaction-selection", () => ({
    useAnchorSelection: () => undefined,
}))

beforeEach(() => vi.clearAllMocks())
afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

describe("localizing a chat row preserves its payload and semantics", () => {
    it.each([
        false,
        true,
    ])("localizes only the command-log wrapper and keeps the path actionable (legacy: %s)", async (legacy) => {
        const { FileServiceClient } = await import("@/services/grpc-client")
        const path = "E:/task/command-logs/run.log"
        const output = legacy ? `raw output\n📋 Output is being logged to: ${path}\nraw tail` : "raw output"
        const row = (
            <CommandOutputContent
                isContainerExpanded
                isOutputFullyExpanded
                logPath={legacy ? undefined : path}
                onToggle={vi.fn()}
                output={output}
            />
        )
        const { rerender } = render(<UiLanguageProvider language="en">{row}</UiLanguageProvider>)
        const notice = screen.getByText("📋 Output is being logged to:")
        const button = notice.closest("button")!
        rerender(<UiLanguageProvider language="zh-CN">{row}</UiLanguageProvider>)
        expect(screen.getByText("📋 输出正记录到：")).toBe(notice)
        await waitFor(() => expect(screen.getByTestId("command-output-scroll")).toHaveTextContent("raw output"))
        fireEvent.click(button)
        await waitFor(() => expect(FileServiceClient.openFile).toHaveBeenCalledWith(expect.objectContaining({ value: path })))
        rerender(<UiLanguageProvider language="en">{row}</UiLanguageProvider>)
        expect(screen.getByText("📋 Output is being logged to:")).toBe(notice)
    })

    it("localizes absent hook metadata and edit headers without translating external names or errors", () => {
        const hook = { ts: 1, type: "say" as const, say: "hook_status" as const, text: "invalid metadata" }
        const output = () => null
        const row = (
            <>
                <HookMessage CommandOutput={output} message={hook} />
                <EditResultRow content="Error: external diagnostic" isExpanded onToggleExpand={vi.fn()} />
            </>
        )
        const { rerender } = render(<UiLanguageProvider language="en">{row}</UiLanguageProvider>)
        expect(screen.getAllByText("Unknown")).toHaveLength(2)
        expect(screen.getByText("Error")).toBeVisible()
        rerender(<UiLanguageProvider language="zh-CN">{row}</UiLanguageProvider>)
        expect(screen.getAllByText("未知")).toHaveLength(2)
        expect(screen.getByText("错误")).toBeVisible()
        expect(screen.getByText("external diagnostic")).toBeVisible()
        rerender(
            <UiLanguageProvider language="zh-CN">
                <HookMessage
                    CommandOutput={output}
                    message={{ ...hook, text: JSON.stringify({ hookName: "Unknown", status: "completed" }) }}
                />
            </UiLanguageProvider>,
        )
        expect(screen.getByText("Unknown")).toBeVisible()
    })

    it("renders ignore-message named slots as code and preserves literal paths across language changes", () => {
        const path = "src/{file}/<raw>.ts"
        const row = (
            <ErrorRow errorType="clineignore_error" message={{ ts: 1, type: "say", say: "clineignore_error", text: path }} />
        )
        const { container, rerender } = render(<UiLanguageProvider language="en">{row}</UiLanguageProvider>)
        const pathNode = screen.getByText(path)
        const fileNode = screen.getByText(".agentignore")
        expect(pathNode.tagName).toBe("CODE")
        expect(fileNode.tagName).toBe("CODE")
        expect(container).toHaveTextContent(`Dline tried to access ${path} which is blocked by the .agentignore file.`)
        rerender(<UiLanguageProvider language="zh-CN">{row}</UiLanguageProvider>)
        expect(container).toHaveTextContent(`Dline 尝试访问 ${path}，该路径被 .agentignore 文件阻止。`)
        expect(screen.getByText(path)).toBe(pathNode)
        expect(screen.getByText(".agentignore")).toBe(fileNode)
        expect(container.querySelector("raw")).toBeNull()
        rerender(<UiLanguageProvider language="en">{row}</UiLanguageProvider>)
        expect(screen.getByText(path)).toBe(pathNode)
    })

    it("translates the compaction classification without freezing the reason", () => {
        expect(compactionFailureKey("output_limit")).toBe("chatRows.errors.compaction.outputLimit")
        expect(describeCompactionFailure("output_limit", enTranslator)).toBe(
            "The reply reached the output token limit before the summary was closed.",
        )
        expect(describeCompactionFailure("output_limit", zh)).toBe("回复在摘要闭合前达到了输出 token 上限。")
        expect(describeCompactionFailure(undefined, zh)).toBeUndefined()
    })

    it("keeps the kill-command phase identity while its label follows the language", () => {
        const { rerender } = render(
            <UiLanguageProvider language="en">
                <KillCommandRowView activityId="a-1" command="npm run build" result="stopping" status="completed" />
            </UiLanguageProvider>,
        )
        const row = screen.getByTestId("kill-command-result")
        expect(row).toHaveAttribute("data-phase", "already_finished")
        expect(within(row).getByText("Command had already finished")).toBeVisible()
        expect(within(row).getByText("npm run build")).toBeVisible()

        rerender(
            <UiLanguageProvider language="zh-CN">
                <KillCommandRowView activityId="a-1" command="npm run build" result="stopping" status="completed" />
            </UiLanguageProvider>,
        )
        expect(screen.getByTestId("kill-command-result")).toBe(row)
        expect(screen.getByTestId("kill-command-result")).toHaveAttribute("data-phase", "already_finished")
        expect(within(row).getByText("命令已经结束")).toBeVisible()
        expect(within(row).getByText("npm run build")).toBeVisible()
    })

    it("keeps the command status semantics independent of the visible wording", () => {
        // The same status arguments select the same key in both languages; only the
        // renderer supplies the language, so a switch cannot change the row's state.
        const key = getCommandStatusKey(false, false, true, false, false, false, 0)
        expect(key).toBe("chatRows.command.status.success")
        expect(translateUi("en", key)).toBe("Success")
        expect(translateUi("zh-CN", key)).toBe("成功")
        expect(getCommandStatusKey(false, false, true, false, false, false, 1)).toBe("chatRows.command.status.failed")
        expect(getCommandStatusKey(true, false, false, false, false, false)).toBe("chatRows.command.status.running")
    })

    it("translates the API error wrapper while the provider payload stays byte-identical", () => {
        const providerMessage = "<provider> quota exhausted for team-x (request req_9)"
        const serialized = JSON.stringify({
            message: providerMessage,
            status: 429,
            code: "rate_limited",
            request_id: "req_9",
            providerId: "openai",
            details: { retry_after: 4 },
        })
        const { rerender } = render(
            <UiLanguageProvider language="en">
                <ApiErrorBox error={serialized} />
            </UiLanguageProvider>,
        )
        expect(screen.getByText("API Request Failed")).toBeVisible()
        expect(screen.getByText(providerMessage)).toBeVisible()
        expect(screen.getByTestId("api-error-box-status")).toHaveTextContent("429")

        rerender(
            <UiLanguageProvider language="zh-CN">
                <ApiErrorBox error={serialized} />
            </UiLanguageProvider>,
        )
        expect(screen.getByText("API 请求失败")).toBeVisible()
        expect(screen.getByText(providerMessage)).toBeVisible()
        expect(screen.getByTestId("api-error-box-request-id")).toHaveTextContent("req_9")
        expect(screen.queryByText("API Request Failed")).not.toBeInTheDocument()
    })

    it("keeps the copy action on the request-failed surface only, by flag rather than by title", () => {
        render(
            <UiLanguageProvider language="zh-CN">
                <ApiErrorBox error='"boom"' title="自定义标题" />
            </UiLanguageProvider>,
        )
        expect(screen.getByText("自定义标题")).toBeVisible()
        expect(screen.queryByRole("button", { name: "复制错误" })).not.toBeInTheDocument()
    })

    it("copies the same localized structure that it renders", async () => {
        const { FileServiceClient } = await import("@/services/grpc-client")
        render(
            <UiLanguageProvider language="zh-CN">
                <ApiErrorBox error={JSON.stringify({ message: "boom", providerId: "openai" })} />
            </UiLanguageProvider>,
        )
        fireEvent.click(screen.getByRole("button", { name: "复制错误" }))
        await waitFor(() =>
            expect(FileServiceClient.copyToClipboard).toHaveBeenCalledWith(
                expect.objectContaining({ value: "API 请求失败\n\nboom\n\n提供方: openai" }),
            ),
        )
    })

    it("retitles ErrorBlockTitle without touching its icon choice", () => {
        const renderTitle = (translated: UiTranslator) => {
            const [icon, title] = ErrorBlockTitle({
                apiRequestFailedMessage: JSON.stringify({ message: "insufficient" }),
                t: translated,
            })
            const view = render(
                <>
                    {icon}
                    {title}
                </>,
            )
            return { icon: icon, text: view.container.textContent, unmount: view.unmount }
        }
        const english = renderTitle(enTranslator)
        expect(english.text).toBe("API Request Failed")
        english.unmount()
        expect(renderTitle(zh).text).toBe("API 请求失败")
    })

    it("updates agent-update and feature-tip copy in the same mounted tree", () => {
        vi.useFakeTimers()
        const { rerender } = render(
            <UiLanguageProvider language="en">
                <AgentUpdateRow kind="phase_report" text="Phase one finished" />
                <FeatureTip />
            </UiLanguageProvider>,
        )
        const row = screen.getByTestId("phase-report-row")
        expect(within(row).getByText("Phase report")).toBeVisible()
        act(() => vi.advanceTimersByTime(2_100))
        expect(screen.getByText("Tip:")).toBeVisible()

        rerender(
            <UiLanguageProvider language="zh-CN">
                <AgentUpdateRow kind="phase_report" text="Phase one finished" />
                <FeatureTip />
            </UiLanguageProvider>,
        )
        expect(screen.getByTestId("phase-report-row")).toBe(row)
        expect(within(row).getByText("阶段报告")).toBeVisible()
        expect(within(row).getByText("Phase one finished")).toBeVisible()
        expect(screen.getByText("提示：")).toBeVisible()
    })

    it("keeps the subagent runtime identifiers raw while its labels follow the language", () => {
        const runtime = {
            profileName: "reviewer",
            providerId: "anthropic",
            modelId: "claude-sonnet-4-6",
            apiFormat: "anthropic",
            thinkingEnabled: true,
        }
        const { rerender } = render(
            <UiLanguageProvider language="en">
                <SubagentRuntimeConfig runtime={runtime} />
            </UiLanguageProvider>,
        )
        expect(screen.getByText("Thinking:")).toBeVisible()
        expect(screen.getByText("enabled")).toBeVisible()
        const modelValue = screen.getByText("claude-sonnet-4-6")
        const profileValue = screen.getByText("reviewer")
        expect(modelValue).toBeVisible()

        rerender(
            <UiLanguageProvider language="zh-CN">
                <SubagentRuntimeConfig runtime={runtime} />
            </UiLanguageProvider>,
        )
        expect(screen.getByText("思考:")).toBeVisible()
        expect(screen.getByText("已启用")).toBeVisible()
        expect(screen.getByText("claude-sonnet-4-6")).toBe(modelValue)
        expect(screen.getByText("reviewer")).toBe(profileValue)
        const identifiers = screen.getAllByText("anthropic")
        expect(identifiers).toHaveLength(2)
        for (const identifier of identifiers) expect(identifier).toBeVisible()
        rerender(
            <UiLanguageProvider language="en">
                <SubagentRuntimeConfig runtime={runtime} />
            </UiLanguageProvider>,
        )
        expect(screen.getByText("Thinking:")).toBeVisible()
        expect(screen.getByText("claude-sonnet-4-6")).toBe(modelValue)
        expect(screen.getByText("reviewer")).toBe(profileValue)
    })
})

describe("localized chat presenters keep semantic inputs", () => {
    it("counts a browser session the same way in both languages", () => {
        const messages = [
            { ts: 1, type: "say" as const, say: "browser_action_launch" as const, text: "https://example.com" },
            {
                ts: 2,
                type: "say" as const,
                say: "browser_action" as const,
                text: JSON.stringify({ action: "click", coordinate: "10,20" }),
            },
            { ts: 3, type: "say" as const, say: "reasoning" as const, text: "thinking" },
            {
                ts: 4,
                type: "say" as const,
                say: "browser_action_result" as const,
                text: JSON.stringify({ currentUrl: "https://example.com/a" }),
            },
            { ts: 5, type: "say" as const, say: "browser_action" as const, text: JSON.stringify({ action: "scroll_down" }) },
            {
                ts: 6,
                type: "say" as const,
                say: "browser_action_result" as const,
                text: JSON.stringify({ currentUrl: "https://example.com/b" }),
            },
        ]
        const projection = projectBrowserSession(messages)
        expect(projection.pages.map((page) => page.state.url)).toEqual(["https://example.com/a", "https://example.com/b"])
        expect(projection.steps.flatMap((step) => step.actions).map((action) => action.action)).toEqual([
            "launch",
            "click",
            "scroll_down",
        ])
        // Launch and click share a round; the thought-only step is not an action round.
        expect(projection.steps.map((step) => step.actions.length)).toEqual([2, 0, 1])
        expect(summarizeBrowserSession(projection.steps, enTranslator)).toBe("1 launch, 1 click, 1 scroll · 1 thought · 2 rounds")
        expect(summarizeBrowserSession(projection.steps, zh)).toBe("1 次启动, 1 次点击, 1 次滚动 · 1 次思考 · 2 轮")
    })

    it("describes browser rows from their fields without leaking the screenshot payload", () => {
        const page = {
            ts: 1,
            type: "say" as const,
            say: "browser_action_result" as const,
            text: JSON.stringify({ currentUrl: "https://example.com/a", screenshot: "data:image/png;base64,SECRET" }),
        }
        expect(describeBrowserMessage(page, enTranslator)).toBe("Browser page: https://example.com/a")
        expect(describeBrowserMessage(page, zh)).toBe("浏览器页面：https://example.com/a")
        expect(describeBrowserMessage(page, zh)).not.toContain("SECRET")
        expect(describeBrowserAction({ action: "launch", text: "https://example.com" }, zh)).toBe(
            "在 https://example.com 启动浏览器",
        )
        expect(describeBrowserAction({ action: "close" }, zh)).toBe("关闭浏览器")
        // An action the product does not name is still reported by its protocol value.
        // @ts-expect-error Exercise an unknown future protocol value at the input boundary.
        expect(describeBrowserAction({ action: "double_click" }, zh)).toBe("double_click")
    })

    it("names every browser phase in both languages", () => {
        const phases = ["awaiting_approval", "declined", "running", "completed", "interrupted", "failed"] as const
        for (const phase of phases) {
            expect(browserSessionPhaseLabel(phase, enTranslator)).not.toBe("")
            expect(browserSessionPhaseLabel(phase, zh)).not.toBe("")
        }
        expect(browserSessionPhaseLabel("completed", zh)).toBe("Dline 使用了浏览器")
    })
})
