import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ButtonHTMLAttributes } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import BrowserSettingsMenu from "./BrowserSettingsMenu"

const mocks = vi.hoisted(() => ({ getInfo: vi.fn(), navigate: vi.fn() }))
vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        browserSettings: { remoteBrowserEnabled: true, remoteBrowserHost: "http://Original-HOST:9222/Path" },
        navigateToSettings: mocks.navigate,
    }),
}))
vi.mock("../../services/grpc-client", () => ({ BrowserServiceClient: { getBrowserConnectionInfo: mocks.getInfo } }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeButton: ({ appearance: _appearance, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }) => (
        <button type="button" {...props} />
    ),
}))
beforeEach(() => vi.clearAllMocks())
afterEach(cleanup)

describe("BrowserSettingsMenu live UI language", () => {
    it.each([
        true,
        false,
    ])("keeps an open connection popover and the original host and navigation (remote: %s)", async (isRemote) => {
        mocks.getInfo.mockResolvedValue({ isConnected: true, isRemote, host: "http://Original-HOST:9222/Path" })
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <BrowserSettingsMenu />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        fireEvent.click(screen.getByRole("button", { name: "Browser connection info" }))
        await screen.findByText("Connected")
        const heading = screen.getByText("Browser Connection")
        const info = screen.getByRole("button", { name: "Browser connection info" })
        const calls = mocks.getInfo.mock.calls.length
        view.rerender(tree("zh-CN"))
        expect(screen.getByText("浏览器连接")).toBe(heading)
        expect(screen.getByText("已连接")).toBeInTheDocument()
        expect(screen.getByText(isRemote ? "远程" : "本地")).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "浏览器连接信息" })).toBe(info)
        if (isRemote) expect(screen.getByText("http://Original-HOST:9222/Path")).toBeInTheDocument()
        fireEvent.click(screen.getByRole("button", { name: "浏览器设置" }))
        expect(mocks.navigate).toHaveBeenCalledWith("browser")
        view.rerender(tree("en"))
        expect(screen.getByText("Browser Connection")).toBe(heading)
        expect(screen.getByRole("button", { name: "Browser connection info" })).toBe(info)
        expect(screen.getByText("Connected")).toBeInTheDocument()
        expect(mocks.getInfo).toHaveBeenCalledTimes(calls)
    })

    it("switches disconnected status both ways without manufacturing connection details", async () => {
        mocks.getInfo.mockResolvedValue({ isConnected: false, isRemote: false, host: "" })
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <BrowserSettingsMenu />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        fireEvent.click(screen.getByRole("button", { name: "Browser connection info" }))
        await waitFor(() => expect(screen.getByText("Disconnected")).toBeInTheDocument())
        view.rerender(tree("zh-CN"))
        expect(screen.getByText("未连接")).toBeInTheDocument()
        expect(screen.queryByText("远程主机：")).not.toBeInTheDocument()
        view.rerender(tree("en"))
        expect(screen.getByText("Disconnected")).toBeInTheDocument()
        expect(screen.queryByText("Remote Host:")).not.toBeInTheDocument()
        expect(mocks.navigate).not.toHaveBeenCalled()
    })
})
