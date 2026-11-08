import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, render, screen } from "@testing-library/react"
import {
    type ButtonHTMLAttributes,
    Children,
    type InputHTMLAttributes,
    isValidElement,
    type PropsWithChildren,
    type SelectHTMLAttributes,
} from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import BrowserSettingsSection from "./BrowserSettingsSection"

const mocks = vi.hoisted(() => ({
    getDetectedChromePath: vi.fn(),
    testBrowserConnection: vi.fn(),
    discoverBrowser: vi.fn(),
    relaunchChromeDebugMode: vi.fn(),
    updateSetting: vi.fn(),
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({
        browserSettings: {
            viewport: { width: 900, height: 600 },
            remoteBrowserEnabled: true,
            remoteBrowserHost: "http://localhost:9222",
        },
    }),
}))
vi.mock("@/services/grpc-client", () => ({ BrowserServiceClient: mocks }))
vi.mock("../utils/settingsHandlers", () => ({ updateSetting: mocks.updateSetting }))
vi.mock("../common/DebouncedTextField", () => ({
    DebouncedTextField: ({ initialValue, id }: { initialValue: string; id?: string }) => (
        <input defaultValue={initialValue} id={id} />
    ),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeButton: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props} />,
    VSCodeCheckbox: ({ children, ...props }: PropsWithChildren<InputHTMLAttributes<HTMLInputElement>>) => (
        <label>
            <input type="checkbox" {...props} />
            {children}
        </label>
    ),
    VSCodeDropdown: ({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) => (
        <select {...props}>
            {Children.toArray(children).filter(
                (child) => !isValidElement<{ slot?: string }>(child) || child.props.slot !== "selected-value",
            )}
        </select>
    ),
    VSCodeOption: ({ children, value }: PropsWithChildren<{ value: string }>) => <option value={value}>{children}</option>,
}))

const tree = (language: UiLanguage) => (
    <UiLanguageProvider language={language}>
        <BrowserSettingsSection renderSectionHeader={() => null} />
    </UiLanguageProvider>
)

async function renderDisconnected() {
    const view = render(tree("en"))
    await act(async () => {})
    return view
}

describe("browser relaunch presentation", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        mocks.getDetectedChromePath.mockReset().mockResolvedValue({ path: "/raw/chrome", isBundled: false })
        mocks.testBrowserConnection.mockReset().mockResolvedValue({ success: false })
        mocks.discoverBrowser.mockReset()
        mocks.relaunchChromeDebugMode.mockReset()
        mocks.updateSetting.mockReset()
        vi.spyOn(console, "error").mockImplementation(() => {})
    })
    afterEach(() => {
        vi.useRealTimers()
        vi.restoreAllMocks()
    })

    it("keeps pending state and translates semantic success without restarting RPCs or its expiry", async () => {
        let resolve!: (value: { value: string }) => void
        mocks.relaunchChromeDebugMode.mockReturnValue(
            new Promise((done) => {
                resolve = done
            }),
        )
        const view = await renderDisconnected()
        const button = screen.getByRole("button", { name: "Launch Browser with Debug Mode" })
        fireEvent.click(button)
        expect(button).toBeDisabled()
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("button", { name: "正在启动浏览器…" })).toBe(button)
        await act(async () => {
            resolve({ value: "host acknowledgement [not product copy]" })
        })
        const notice = screen.getByText("已发起 Chrome 重新启动。")
        expect(screen.queryByText("host acknowledgement [not product copy]")).not.toBeInTheDocument()
        await act(async () => {
            vi.advanceTimersByTime(10_000)
        })
        const pollCount = mocks.testBrowserConnection.mock.calls.length
        view.rerender(tree("en"))
        expect(screen.getByText("Chrome relaunch initiated.")).toBe(notice)
        view.rerender(tree("zh-CN"))
        expect(screen.getByText("已发起 Chrome 重新启动。")).toBe(notice)
        expect(mocks.testBrowserConnection).toHaveBeenCalledTimes(pollCount)
        expect(mocks.getDetectedChromePath).toHaveBeenCalledTimes(1)
        expect(mocks.relaunchChromeDebugMode).toHaveBeenCalledExactlyOnceWith({})
        expect(mocks.discoverBrowser).not.toHaveBeenCalled()
        expect(mocks.updateSetting).not.toHaveBeenCalled()
        await act(async () => {
            vi.advanceTimersByTime(5_000)
        })
        expect(notice).not.toBeInTheDocument()
    })

    it("wraps a raw failure without interpreting diagnostic text as a success identity", async () => {
        const diagnostic = "Chrome relaunch initiated [raw failure /路径]"
        mocks.relaunchChromeDebugMode.mockRejectedValue(new Error(diagnostic))
        const view = await renderDisconnected()
        fireEvent.click(screen.getByRole("button", { name: "Launch Browser with Debug Mode" }))
        await act(async () => {})
        const notice = screen.getByText(`Error relaunching Chrome: ${diagnostic}`)
        view.rerender(tree("zh-CN"))
        expect(screen.getByText(`重新启动 Chrome 时出错：${diagnostic}`)).toBe(notice)
        view.rerender(tree("en"))
        expect(screen.getByText(`Error relaunching Chrome: ${diagnostic}`)).toBe(notice)
        expect(mocks.relaunchChromeDebugMode).toHaveBeenCalledTimes(1)
        expect(mocks.testBrowserConnection).toHaveBeenCalledTimes(1)
    })
})
