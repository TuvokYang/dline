import { ClaudeCodeAuthFlow, ClaudeCodeAuthStatus, OpenAiCodexBrowserOpenStatus } from "@shared/proto/dline/account"
import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { ClaudeCodeOAuthControl } from "./ClaudeCodeOAuthControl"

const mocks = vi.hoisted(() => ({
    getClaudeCodeAuthStatus: vi.fn(),
    startClaudeCodeSignIn: vi.fn(),
    completeClaudeCodeSignIn: vi.fn(),
    cancelClaudeCodeSignIn: vi.fn(),
    signOutClaudeCodeProfile: vi.fn(),
}))
vi.mock("@/services/grpc-client", () => ({
    AccountServiceClient: mocks,
    FileServiceClient: { copyToClipboard: vi.fn() },
    WebServiceClient: { openInBrowser: vi.fn() },
}))
vi.mock("./ProviderUsage", () => ({ ProviderUsage: () => null }))

const profileId = "claude-raw-profile"
const tree = (language: UiLanguage) => (
    <UiLanguageProvider language={language}>
        <ClaudeCodeOAuthControl profileId={profileId} />
    </UiLanguageProvider>
)
const englishWrappers = {
    start: "Cannot start the Claude sign-in. Try again.",
    complete: "Cannot finish the Claude sign-in. Check the callback URL or authorization code and try again.",
    signOut: "Cannot sign out of this Claude profile. Try again.",
}
const chineseWrappers = {
    start: "无法开始 Claude 登录。请重试。",
    complete: "无法完成 Claude 登录。请检查回调 URL 或授权码后重试。",
    signOut: "无法退出此 Claude 配置的登录。请重试。",
}

describe("Claude OAuth operation errors", () => {
    beforeEach(() => {
        for (const mock of Object.values(mocks)) mock.mockReset()
        mocks.getClaudeCodeAuthStatus.mockResolvedValue({ status: ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_MISSING })
        mocks.startClaudeCodeSignIn.mockResolvedValue(
            ClaudeCodeAuthFlow.create({
                profileId,
                flowId: "flow-raw-id",
                authorizationUrl: "https://claude.example/authorize?state=raw",
                expiresAtMs: Date.now() + 600_000,
                loopbackListening: true,
                browserOpenStatus: OpenAiCodexBrowserOpenStatus.OPEN_AI_CODEX_BROWSER_OPEN_STATUS_OPENED,
            }),
        )
    })

    it.each([
        "start",
        "complete",
        "signOut",
    ] as const)("reactively wraps %s failures without replaying the operation", async (operation) => {
        const diagnostic = "OAuth failure [raw STATE_MISMATCH /原始诊断]"
        const rpc =
            operation === "start"
                ? mocks.startClaudeCodeSignIn
                : operation === "complete"
                  ? mocks.completeClaudeCodeSignIn
                  : mocks.signOutClaudeCodeProfile
        rpc.mockRejectedValueOnce(new Error(diagnostic))
        if (operation === "signOut")
            mocks.getClaudeCodeAuthStatus.mockResolvedValue({
                status: ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_AUTHENTICATED,
                account: { displayName: "Raw account [用户内容]", email: "user@example.test" },
            })
        const view = render(tree("en"))
        await waitFor(() => expect(mocks.getClaudeCodeAuthStatus).toHaveBeenCalledTimes(1))
        await act(async () => {})
        if (operation === "signOut") fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
        else {
            fireEvent.click(screen.getByRole("button", { name: "Sign in" }))
            if (operation === "complete") {
                const field = await screen.findByRole("textbox", { name: "Callback URL or authorization code" })
                fireEvent.change(field, { target: { value: "code-raw#state-raw" } })
                field.focus()
                const dialog = screen.getByRole("dialog")
                view.rerender(tree("zh-CN"))
                expect(screen.getByRole("dialog")).toBe(dialog)
                expect(screen.getByRole("textbox", { name: "回调 URL 或授权码" })).toBe(field)
                expect(field).toHaveFocus()
                expect(field).toHaveValue("code-raw#state-raw")
                view.rerender(tree("en"))
                expect(field).toHaveValue("code-raw#state-raw")
                fireEvent.click(screen.getByRole("button", { name: "Finish sign-in" }))
            }
        }
        const alert = await screen.findByRole("alert")
        expect(screen.getAllByRole("alert")).toHaveLength(1)
        expect(alert).toHaveTextContent(`${englishWrappers[operation]} ${diagnostic}`)
        if (operation === "signOut") {
            expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
            expect(screen.getByRole("group", { name: "Signed-in Claude account" })).toHaveTextContent("Raw account [用户内容]")
        } else expect(within(screen.getByRole("dialog")).getByRole("alert")).toBe(alert)
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("alert")).toBe(alert)
        expect(alert).toHaveTextContent(`${chineseWrappers[operation]} ${diagnostic}`)
        view.rerender(tree("en"))
        expect(alert).toHaveTextContent(`${englishWrappers[operation]} ${diagnostic}`)
        expect(mocks.getClaudeCodeAuthStatus).toHaveBeenCalledTimes(1)
        expect(rpc).toHaveBeenCalledTimes(1)
        expect(mocks.cancelClaudeCodeSignIn).not.toHaveBeenCalled()
        expect(rpc).toHaveBeenLastCalledWith(
            operation === "complete" ? { profileId, flowId: "flow-raw-id", pastedValue: "code-raw#state-raw" } : { profileId },
        )

        // Unknown failures still name the attempted operation rather than falling
        // back to a generic error or manufacturing a diagnostic string.
        rpc.mockRejectedValueOnce(undefined)
        if (operation === "complete") {
            fireEvent.change(screen.getByRole("textbox", { name: "Callback URL or authorization code" }), {
                target: { value: "retry#raw" },
            })
        }
        fireEvent.click(
            screen.getByRole("button", {
                name: operation === "start" ? "Try again" : operation === "complete" ? "Finish sign-in" : "Sign out",
            }),
        )
        await waitFor(() => expect(screen.getByRole("alert").textContent).toBe(englishWrappers[operation]))
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("alert").textContent).toBe(chineseWrappers[operation])
        view.rerender(tree("en"))
        expect(screen.getByRole("alert").textContent).toBe(englishWrappers[operation])
        expect(rpc).toHaveBeenCalledTimes(2)
        expect(mocks.getClaudeCodeAuthStatus).toHaveBeenCalledTimes(1)
    })
})
