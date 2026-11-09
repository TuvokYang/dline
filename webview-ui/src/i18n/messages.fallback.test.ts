import { describe, expect, it, vi } from "vitest"
import { translateUi } from "./messages"

// Deliberately incomplete runtime resource: production resources still require full typed parity.
vi.mock("./zh_CN", () => ({ zhCN: { "settings.title": "设置" } }))

describe("English runtime entry fallback", () => {
    it("keeps an available Chinese entry", () => {
        expect(translateUi("zh-CN", "settings.title")).toBe("设置")
    })

    it("uses the English baseline when a static Chinese entry is unavailable", () => {
        expect(translateUi("zh-CN", "settings.done")).toBe("Done")
        expect(translateUi("zh-CN", "settings.general.uiLanguage.saveError")).toBe(
            "Couldn't confirm the interface language update. Please try again.",
        )
    })

    it("invokes the English baseline with the same named arguments when a dynamic entry is unavailable", () => {
        expect(translateUi("zh-CN", "settings.general.uiLanguage.followHost", { language: "简体中文" })).toBe(
            "Auto uses the VS Code display language (简体中文).",
        )
    })
})
