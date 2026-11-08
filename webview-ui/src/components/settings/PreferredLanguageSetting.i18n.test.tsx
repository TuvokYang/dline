import { act, fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import PreferredLanguageSetting from "./PreferredLanguageSetting"

const state = vi.hoisted(() => ({ preferredLanguage: "English" }))
const updateSetting = vi.hoisted(() => vi.fn())
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))
vi.mock("./utils/settingsHandlers", () => ({ updateSetting }))

function control(language: "en" | "zh-CN") {
    return (
        <UiLanguageProvider language={language}>
            <PreferredLanguageSetting />
        </UiLanguageProvider>
    )
}

describe("model communication language", () => {
    it("localizes every option without changing its saved value or remounting the dropdown", () => {
        const { container, rerender } = render(control("en"))
        const dropdown = screen.getByLabelText("Model response language")
        const englishOptions = Array.from(container.querySelectorAll("vscode-option"))
        expect(englishOptions.map((option) => option.textContent)).toEqual([
            "Auto",
            "English",
            "Arabic",
            "Portuguese (Brazil)",
            "Czech",
            "French",
            "German",
            "Hindi",
            "Hungarian",
            "Italian",
            "Japanese",
            "Korean",
            "Polish",
            "Portuguese (Portugal)",
            "Russian",
            "Simplified Chinese",
            "Spanish",
            "Traditional Chinese",
            "Turkish",
        ])
        expect(
            screen.getByText("Choose the language for model replies. Auto follows the language you use in your messages."),
        ).toBeVisible()
        const values = englishOptions.map((option) => option.getAttribute("value"))
        rerender(control("zh-CN"))
        expect(screen.getByLabelText("模型沟通语言")).toBe(dropdown)
        const chineseOptions = Array.from(container.querySelectorAll("vscode-option"))
        expect(chineseOptions.map((option) => option.textContent)).toEqual([
            "自动",
            "英语",
            "阿拉伯语",
            "葡萄牙语（巴西）",
            "捷克语",
            "法语",
            "德语",
            "印地语",
            "匈牙利语",
            "意大利语",
            "日语",
            "韩语",
            "波兰语",
            "葡萄牙语（葡萄牙）",
            "俄语",
            "简体中文",
            "西班牙语",
            "繁体中文",
            "土耳其语",
        ])
        expect(chineseOptions.map((option) => option.getAttribute("value"))).toEqual(values)
        expect(values).toContain("Simplified Chinese - 简体中文")
        expect(values[0]).toBe("auto")
        expect(updateSetting).not.toHaveBeenCalled()
        rerender(control("en"))
        expect(screen.getByLabelText("Model response language")).toBe(dropdown)
    })

    it("sends Auto as a model preference, never as an interface language update", async () => {
        const { container } = render(control("zh-CN"))
        const dropdown = container.querySelector("#preferred-language-dropdown")!
        Object.defineProperty(dropdown, "value", { configurable: true, writable: true, value: "auto" })
        await act(async () => fireEvent.change(dropdown))
        expect(updateSetting).toHaveBeenCalledExactlyOnceWith("preferredLanguage", "auto")
    })
})
