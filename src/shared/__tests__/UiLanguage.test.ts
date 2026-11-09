import { describe, expect, expectTypeOf, it } from "vitest"
import {
    DEFAULT_UI_LANGUAGE,
    DEFAULT_UI_LANGUAGE_PREFERENCE,
    isUiLanguage,
    isUiLanguagePreference,
    normalizeUiLanguage,
    normalizeUiLanguagePreference,
    resolveUiLanguage,
    UI_LANGUAGE_LABELS,
    UI_LANGUAGES,
    type UiLanguage,
    type UiLanguagePreference,
} from "../UiLanguage"

describe("UI language values", () => {
    it("separates the auto preference default from the English display fallback", () => {
        expect(UI_LANGUAGES).toEqual(["en", "zh-CN"])
        expect(UI_LANGUAGE_LABELS).toEqual({ en: "English", "zh-CN": "简体中文" })
        expect(DEFAULT_UI_LANGUAGE).toBe("en")
        expect(DEFAULT_UI_LANGUAGE_PREFERENCE).toBe("auto")
        expectTypeOf<UiLanguage>().toEqualTypeOf<"en" | "zh-CN">()
        expectTypeOf<UiLanguagePreference>().toEqualTypeOf<"auto" | "en" | "zh-CN">()
    })

    it.each(["en", "zh-CN"] as const)("accepts and preserves the explicit language %s", (value) => {
        expect(isUiLanguage(value)).toBe(true)
        expect(isUiLanguagePreference(value)).toBe(true)
        expect(normalizeUiLanguage(value)).toBe(value)
        expect(normalizeUiLanguagePreference(value)).toBe(value)
    })

    it("recognizes auto as a preference, never as a display language", () => {
        expect(isUiLanguage("auto")).toBe(false)
        expect(isUiLanguagePreference("auto")).toBe(true)
        expect(normalizeUiLanguagePreference("auto")).toBe("auto")
        expect(normalizeUiLanguage("auto")).toBe("en")
    })

    it.each([
        undefined,
        null,
        "",
        "English",
        "Simplified Chinese - 简体中文",
        "zh-cn",
        "unsupported",
        1,
        {},
        [],
    ])("reads missing or invalid preference %j as auto without changing display normalization", (value) => {
        expect(isUiLanguage(value)).toBe(false)
        expect(isUiLanguagePreference(value)).toBe(false)
        expect(normalizeUiLanguagePreference(value)).toBe("auto")
        expect(normalizeUiLanguage(value)).toBe("en")
    })
})

describe("resolveUiLanguage", () => {
    it.each([
        "zh",
        "zh-cn",
        "ZH-CN",
        "zH-cN",
        "zh_Hans",
        "ZH_hans_CN",
        "zh-Hans-CN",
        "zh_CN",
        "zh-Hant",
    ])("follows the Chinese host variant %s", (hostLanguage) => {
        expect(resolveUiLanguage("auto", hostLanguage)).toBe("zh-CN")
        expect(resolveUiLanguage(undefined, hostLanguage)).toBe("zh-CN")
        expect(resolveUiLanguage("invalid", hostLanguage)).toBe("zh-CN")
    })

    it.each([
        undefined,
        "",
        "en",
        "EN",
        "en-US",
        "en_US",
        "unsupported",
        "zhish",
        "zhCN",
    ])("uses English for absent or unmatched host metadata %j", (hostLanguage) => {
        expect(resolveUiLanguage("auto", hostLanguage)).toBe("en")
        expect(resolveUiLanguage(null, hostLanguage)).toBe("en")
    })

    it.each([undefined, "en", "zh", "ZH-CN", "unsupported"])("gives explicit preferences priority over host %j", (host) => {
        expect(resolveUiLanguage("en", host)).toBe("en")
        expect(resolveUiLanguage("zh-CN", host)).toBe("zh-CN")
    })

    it("resolves each auto read afresh without replacing the preference or mutating the input", () => {
        const settings = Object.freeze({ uiLanguage: "auto", preferredLanguage: "English" })
        expect(resolveUiLanguage(settings.uiLanguage, "zh_Hans")).toBe("zh-CN")
        expect(resolveUiLanguage("en", "zh_Hans")).toBe("en")
        expect(resolveUiLanguage(settings.uiLanguage, "zh_Hans")).toBe("zh-CN")
        expect(resolveUiLanguage(settings.uiLanguage, "en")).toBe("en")
        expect(settings).toEqual({ uiLanguage: "auto", preferredLanguage: "English" })
    })

    it("does not treat model-language labels as UI preferences", () => {
        expect(resolveUiLanguage("English", "zh-CN")).toBe("zh-CN")
        expect(resolveUiLanguage("Simplified Chinese - 简体中文", "en")).toBe("en")
    })
})
