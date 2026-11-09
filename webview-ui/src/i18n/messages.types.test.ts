import { describe, expect, expectTypeOf, it } from "vitest"
import { en } from "./en"
import { translateUi, type UiMessageArgs, type UiMessageKey, type UiMessages, type UiTranslator } from "./messages"
import { zhCN } from "./zh_CN"

// Never execute the invalid calls. The scoped no-emit TS check verifies every expected error.
function assertInvalidCalls(t: UiTranslator, unresolvedKey: UiMessageKey) {
    // @ts-expect-error Only declared message keys are accepted.
    translateUi("en", "settings.unknown")
    // @ts-expect-error auto is a preference, not a resolved display language.
    translateUi("auto", "settings.title")
    // @ts-expect-error Static messages cannot receive parameters.
    translateUi("en", "settings.title", {})
    // @ts-expect-error Static messages do not accept even explicit undefined arguments.
    translateUi("en", "settings.title", undefined)
    // @ts-expect-error The follow-host message requires its named arguments.
    translateUi("en", "settings.general.uiLanguage.followHost")
    // @ts-expect-error The language parameter is required.
    translateUi("en", "settings.general.uiLanguage.followHost", {})
    // @ts-expect-error Argument names cannot be replaced by positional values.
    translateUi("en", "settings.general.uiLanguage.followHost", "English")
    // @ts-expect-error The language parameter is text, not a number.
    translateUi("en", "settings.general.uiLanguage.followHost", { language: 1 })
    // @ts-expect-error Unknown named arguments are rejected.
    translateUi("en", "settings.general.uiLanguage.followHost", { language: "English", unknown: true })
    // @ts-expect-error A mixed key union must be narrowed before its argument contract is known.
    translateUi("en", unresolvedKey)
    // @ts-expect-error A translator must not accept a possibly dynamic key without arguments.
    t(unresolvedKey)
    // @ts-expect-error Unknown keys are also rejected through an injected translator.
    t("settings.unknown")
    // @ts-expect-error Static translator calls cannot receive parameters.
    t("settings.title", { language: "English" })
    // @ts-expect-error Dynamic translator calls require named parameters.
    t("settings.general.uiLanguage.followHost")
    // @ts-expect-error The translator preserves the named parameter's type.
    t("settings.general.uiLanguage.followHost", { language: false })
    // @ts-expect-error A translated dynamic entry must accept the baseline's parameter names.
    const wrongNames: UiMessages["settings.general.uiLanguage.followHost"] = (_args: { host: string }) => ""
    // @ts-expect-error A translated dynamic entry must accept the baseline's parameter types.
    const wrongTypes: UiMessages["settings.general.uiLanguage.followHost"] = (_args: { language: number }) => ""
    // @ts-expect-error A dynamic entry cannot be replaced by a static string.
    const wrongKind: UiMessages["settings.general.uiLanguage.followHost"] = "static text"
    return [wrongNames, wrongTypes, wrongKind]
}

describe("UI message type contract", () => {
    it("preserves exact resource keys and named parameter types", () => {
        expectTypeOf<keyof typeof en>().toEqualTypeOf<UiMessageKey>()
        expectTypeOf<keyof typeof zhCN>().toEqualTypeOf<UiMessageKey>()
        expectTypeOf<UiMessageArgs<"settings.title">>().toEqualTypeOf<[]>()
        expectTypeOf<UiMessageArgs<"settings.general.uiLanguage.followHost">>().toEqualTypeOf<[{ language: string }]>()
        expectTypeOf<Parameters<(typeof zhCN)["settings.general.uiLanguage.followHost"]>>().toEqualTypeOf<
            UiMessageArgs<"settings.general.uiLanguage.followHost">
        >()
        expectTypeOf(assertInvalidCalls).parameter(0).toEqualTypeOf<UiTranslator>()
    })

    it("supports both pure presenters and injected translators without widening keys", () => {
        const t: UiTranslator = (key, ...args) => translateUi("zh-CN", key, ...args)
        const presentFollowHost = (translate: UiTranslator) =>
            translate("settings.general.uiLanguage.followHost", { language: "English" })
        expect(t("settings.title")).toBe("设置")
        expect(presentFollowHost(t)).toBe("自动模式使用 VS Code 显示语言（English）。")
    })
})
