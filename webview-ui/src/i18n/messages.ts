import type { UiLanguage } from "@shared/UiLanguage"
import { en, type UiMessageArgs, type UiMessageKey, type UiMessages } from "./en"
import { zhCN } from "./zh_CN"

export type { UiMessageArgs, UiMessageKey, UiMessages } from "./en"

export type UiTranslator = <K extends UiMessageKey>(key: K, ...args: UiMessageArgs<K>) => string

/** Explicit baseline for pure presenters whose existing callers do not select a display language. */
export const englishUiTranslator: UiTranslator = (key, ...args) => translateUi("en", key, ...args)

export const UI_MESSAGES: Readonly<Record<UiLanguage, UiMessages>> = {
    en,
    "zh-CN": zhCN,
}

/** Product-owned labels only; user, model and external content never pass through this lookup. */
export function translateUi<K extends UiMessageKey>(language: UiLanguage, key: K, ...args: UiMessageArgs<K>): string {
    const message = UI_MESSAGES[language][key] ?? en[key]
    if (typeof message === "string") return message

    // The key and its arguments are correlated by the public signature, but indexing
    // a mapped resource by a generic key does not preserve that correlation in TS.
    return (message as (...parameters: UiMessageArgs<K>) => string)(...args)
}
