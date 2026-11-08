import { resolveUiLanguage, type UiLanguagePreference } from "@shared/UiLanguage"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import UiLanguageSetting from "../UiLanguageSetting"

function deferred() {
    let resolve!: () => void
    let reject!: (reason: unknown) => void
    const promise = new Promise<void>((yes, no) => {
        resolve = yes
        reject = no
    })
    return { promise, resolve, reject }
}

function control(preference: UiLanguagePreference, save: (value: UiLanguagePreference) => Promise<unknown>, host = "zh-CN") {
    return (
        <UiLanguageProvider language={resolveUiLanguage(preference, host)}>
            <UiLanguageSetting hostDisplayLanguage={host} onPreferenceChange={save} preference={preference} />
        </UiLanguageProvider>
    )
}

function select(container: HTMLElement, value: string) {
    const dropdown = container.querySelector("#ui-language-dropdown")!
    Object.defineProperty(dropdown, "value", { configurable: true, value, writable: true })
    fireEvent.change(dropdown)
}

describe("UI language preference control", () => {
    it("keeps the Auto option concise and explains the host language outside the dropdown", () => {
        const { container } = render(
            control(
                "en",
                vi.fn(async () => undefined),
            ),
        )
        const dropdown = screen.getByLabelText("Interface language")
        expect(dropdown).toHaveAttribute(
            "aria-describedby",
            "ui-language-description ui-language-auto-description ui-language-coverage",
        )
        expect(container.querySelector('vscode-option[value="auto"]')?.textContent).toBe("Auto")
        expect(container.querySelector("#ui-language-auto-description")).toHaveTextContent(
            "Auto uses the VS Code display language (简体中文).",
        )
        expect(container.querySelector('vscode-option[value="en"]')).toHaveTextContent("English")
        expect(container.querySelector('vscode-option[value="zh-CN"]')).toHaveTextContent("简体中文")
    })

    it("awaits saving a preference and does not change the committed prop optimistically", async () => {
        const request = deferred()
        const save = vi.fn(() => request.promise)
        const { container, rerender } = render(control("en", save))
        select(container, "zh-CN")
        expect(save).toHaveBeenCalledExactlyOnceWith("zh-CN")
        expect(screen.getByRole("status")).toHaveTextContent("Saving interface language")
        expect(screen.getByLabelText("Interface language")).toBeInTheDocument()
        await act(async () => request.resolve())
        expect(screen.queryByRole("status")).not.toBeInTheDocument()
        expect(screen.getByLabelText("Interface language")).toBeInTheDocument()
        rerender(control("zh-CN", save))
        expect(screen.getByLabelText("界面语言")).toBeInTheDocument()
        expect(save).toHaveBeenCalledTimes(1)
    })

    it("shows a localized safe failure and retries the same desired preference", async () => {
        const request = deferred()
        const save = vi.fn().mockReturnValueOnce(request.promise).mockResolvedValue(undefined)
        const { container } = render(control("auto", save))
        select(container, "en")
        await act(async () => request.reject(new Error("private account payload")))
        expect(screen.getByRole("alert")).toHaveTextContent("无法确认界面语言更新")
        expect(screen.queryByText("private account payload")).not.toBeInTheDocument()
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试" })))
        expect(save.mock.calls.map(([value]) => value)).toEqual(["en", "en"])
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    })

    it("does not turn a late RPC rejection into failure after a matching committed publication", async () => {
        const request = deferred()
        const save = vi.fn(() => request.promise)
        const { container, rerender } = render(control("en", save))
        select(container, "zh-CN")
        rerender(control("zh-CN", save))
        await act(async () => request.reject(new Error("publication failed after commit")))
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
        expect(screen.getByLabelText("界面语言")).toBeInTheDocument()
    })

    it("does not mistake an unrelated publication for a matching commit", async () => {
        const request = deferred()
        const save = vi.fn(() => request.promise)
        const { container, rerender } = render(control("en", save))
        select(container, "zh-CN")
        rerender(control("en", save, "en"))
        await act(async () => request.reject(new Error("write failed")))
        expect(screen.getByRole("alert")).toHaveTextContent("Couldn't confirm the interface language update")
    })

    it("ignores feedback for an older intent while a newer selection remains pending", async () => {
        const first = deferred()
        const second = deferred()
        const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
        const { container } = render(control("en", save))
        select(container, "zh-CN")
        select(container, "auto")
        await act(async () => first.reject(new Error("old failure")))
        expect(screen.queryByRole("alert")).not.toBeInTheDocument()
        expect(screen.getByRole("status")).toBeInTheDocument()
        await act(async () => second.resolve())
        expect(save.mock.calls.map(([value]) => value)).toEqual(["zh-CN", "auto"])
        expect(screen.queryByRole("status")).not.toBeInTheDocument()
    })

    it.each([
        "before rejection",
        "after rejection",
    ] as const)("reports a failed quick return to the original preference when the first commit arrives %s", async (publication) => {
        const first = deferred()
        const second = deferred()
        const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockResolvedValue(undefined)
        const { container, rerender } = render(control("en", save))
        select(container, "zh-CN")
        select(container, "en")
        await act(async () => first.resolve())
        if (publication === "before rejection") rerender(control("zh-CN", save))
        await act(async () => second.reject(new Error("second write failed")))
        expect(screen.getByRole("alert")).toBeInTheDocument()
        if (publication === "after rejection") rerender(control("zh-CN", save))
        expect(screen.getByRole("alert")).toHaveTextContent("无法确认界面语言更新")
        await act(async () => fireEvent.click(screen.getByRole("button", { name: "重试" })))
        expect(save.mock.calls.map(([value]) => value)).toEqual(["zh-CN", "en", "en"])
    })

    it("renders an existing error in the new language without remounting the control", async () => {
        const save = vi.fn().mockRejectedValue(new Error("write failed"))
        const { container, rerender } = render(control("en", save))
        const dropdown = container.querySelector("#ui-language-dropdown")
        await act(async () => select(container, "auto"))
        expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
        rerender(control("zh-CN", save))
        expect(container.querySelector("#ui-language-dropdown")).toBe(dropdown)
        expect(screen.getByRole("button", { name: "重试" })).toBeInTheDocument()
    })

    it("ignores invalid input and an unchanged committed choice", () => {
        const save = vi.fn(async () => undefined)
        const { container } = render(control("en", save))
        select(container, "invalid")
        select(container, "en")
        expect(save).not.toHaveBeenCalled()
    })
})
