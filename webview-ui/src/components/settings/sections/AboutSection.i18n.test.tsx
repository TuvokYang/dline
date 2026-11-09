import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, render, screen } from "@testing-library/react"
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, PropsWithChildren } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import AboutSection from "./AboutSection"

const mocks = vi.hoisted(() => ({ exportBundle: vi.fn(), updateSetting: vi.fn() }))
vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ usageReportingSetting: "unset", errorReportingSetting: "enabled" }),
}))
vi.mock("@/services/grpc-client", () => ({
    StateServiceClient: { exportRuntimeTelemetryBundle: mocks.exportBundle },
}))
vi.mock("../utils/settingsHandlers", () => ({ updateSetting: mocks.updateSetting }))
vi.mock("../SupportTelemetryStatus", () => ({ SupportTelemetryStatus: () => null }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeButton: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button type="button" {...props} />,
    VSCodeCheckbox: ({ children }: PropsWithChildren) => <span>{children}</span>,
    VSCodeLink: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))

const tree = (language: UiLanguage) => (
    <UiLanguageProvider language={language}>
        <AboutSection renderSectionHeader={() => null} version="1.2.3" />
    </UiLanguageProvider>
)

describe("diagnostic export failure presentation", () => {
    beforeEach(() => {
        mocks.exportBundle.mockReset()
        mocks.updateSetting.mockReset()
    })

    it.each(["response", "exception"])("wraps a %s failure reactively and allows an explicit retry", async (failure) => {
        const diagnostic = "EACCES: /raw/诊断包.zip [provider diagnostic]"
        if (failure === "response") mocks.exportBundle.mockResolvedValue({ error: diagnostic })
        else mocks.exportBundle.mockRejectedValue(new Error(diagnostic))
        const view = render(tree("en"))
        fireEvent.click(screen.getByRole("button", { name: "Export diagnostic bundle" }))
        const notice = await screen.findByTestId("diagnostic-bundle-error")
        expect(notice).toHaveTextContent(`Could not export the diagnostic bundle: ${diagnostic}`)
        view.rerender(tree("zh-CN"))
        expect(screen.getByTestId("diagnostic-bundle-error")).toBe(notice)
        expect(notice).toHaveTextContent(`无法导出诊断包：${diagnostic}`)
        view.rerender(tree("en"))
        expect(notice).toHaveTextContent(`Could not export the diagnostic bundle: ${diagnostic}`)
        expect(mocks.exportBundle).toHaveBeenCalledExactlyOnceWith({ includeRawArtifacts: undefined })

        let resolve!: (value: { path: string; sizeBytes: number }) => void
        mocks.exportBundle.mockReturnValueOnce(
            new Promise((done) => {
                resolve = done
            }),
        )
        fireEvent.click(screen.getByRole("button", { name: "Export diagnostic bundle" }))
        expect(notice).not.toBeInTheDocument()
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("button", { name: "正在导出…" })).toBeDisabled()
        await act(async () => {
            resolve({ path: "/raw/诊断包.zip", sizeBytes: 2048 })
        })
        expect(screen.getByTestId("diagnostic-bundle-written")).toHaveTextContent("已保存到 /raw/诊断包.zip（2.0 KB）。")
        view.rerender(tree("en"))
        expect(screen.getByTestId("diagnostic-bundle-written")).toHaveTextContent("Saved to /raw/诊断包.zip (2.0 KB).")
        expect(mocks.exportBundle).toHaveBeenCalledTimes(2)
        expect(mocks.updateSetting).not.toHaveBeenCalled()
    })
})
