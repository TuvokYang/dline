import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { ButtonHTMLAttributes } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { SupportTelemetryStatus } from "./SupportTelemetryStatus"

const mocks = vi.hoisted(() => ({ getStatus: vi.fn(), checkNow: vi.fn(), deleteAndRevoke: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({ SupportServiceClient: mocks }))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeButton: ({ appearance: _appearance, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { appearance?: string }) => (
        <button type="button" {...props} />
    ),
}))

const status = {
    present: true,
    publicCode: "DLN-RAW-CODE",
    state: "approved",
    issueState: "open",
    authorizationExpiresAt: Date.now() + 60_000,
    resolution: { state: "investigating", summary: "Maintainer note [原始内容]" },
}
const tree = (language: UiLanguage) => (
    <UiLanguageProvider language={language}>
        <SupportTelemetryStatus />
    </UiLanguageProvider>
)

describe("support operation failures", () => {
    beforeEach(() => {
        mocks.getStatus.mockReset().mockResolvedValue(status)
        mocks.checkNow.mockReset()
        mocks.deleteAndRevoke.mockReset()
    })

    it.each(["check", "delete"])("keeps %s identity and raw diagnostics across language switches and retries", async (action) => {
        // Identical diagnostics must still get different action-specific wrappers.
        const diagnostic = "service denied [device_revoked /原始诊断]"
        const operation = action === "check" ? mocks.checkNow : mocks.deleteAndRevoke
        operation.mockRejectedValueOnce(new Error(diagnostic))
        const view = render(tree("en"))
        await screen.findByTestId("support-public-code")
        if (action === "delete") fireEvent.click(screen.getByRole("button", { name: "Delete & Revoke" }))
        fireEvent.click(screen.getByRole("button", { name: action === "check" ? "Check now" : "Confirm delete & revoke" }))
        const notice = await screen.findByTestId("support-telemetry-error")
        const english =
            action === "check"
                ? `Could not check the temporary support telemetry status: ${diagnostic}`
                : `Could not delete and revoke temporary support telemetry: ${diagnostic}`
        const chinese =
            action === "check" ? `无法检查临时支持遥测状态：${diagnostic}` : `无法删除并撤销临时支持遥测：${diagnostic}`
        expect(notice).toHaveTextContent(english)
        view.rerender(tree("zh-CN"))
        expect(screen.getByTestId("support-telemetry-error")).toBe(notice)
        expect(notice).toHaveTextContent(chinese)
        expect(screen.getByTestId("support-public-code")).toHaveTextContent(status.publicCode)
        expect(screen.getByTestId("support-resolution-summary")).toHaveTextContent(status.resolution.summary)
        if (action === "delete") expect(screen.getByRole("button", { name: "确认删除并撤销" })).toBeEnabled()
        view.rerender(tree("en"))
        expect(notice).toHaveTextContent(english)
        expect(operation).toHaveBeenCalledExactlyOnceWith({})
        expect(mocks.getStatus).toHaveBeenCalledTimes(1)

        let resolve!: (value: typeof status) => void
        operation.mockReturnValueOnce(
            new Promise((done) => {
                resolve = done
            }),
        )
        fireEvent.click(screen.getByRole("button", { name: action === "check" ? "Check now" : "Confirm delete & revoke" }))
        expect(notice).not.toBeInTheDocument()
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("button", { name: action === "check" ? "正在检查…" : "正在删除…" })).toBeDisabled()
        await act(async () => {
            resolve(status)
        })
        await waitFor(() => expect(screen.getByRole("button", { name: "立即检查" })).toBeEnabled())
        expect(operation).toHaveBeenCalledTimes(2)
        expect(mocks.getStatus).toHaveBeenCalledTimes(action === "check" ? 1 : 2)
        expect(screen.queryByTestId("support-telemetry-error")).not.toBeInTheDocument()
        if (action === "check") expect(mocks.deleteAndRevoke).not.toHaveBeenCalled()
        else expect(mocks.checkNow).not.toHaveBeenCalled()
    })
})
