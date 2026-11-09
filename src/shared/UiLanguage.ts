export const UI_LANGUAGES = ["en", "zh-CN"] as const

export type UiLanguage = (typeof UI_LANGUAGES)[number]
export type UiLanguagePreference = "auto" | UiLanguage

/** Safe rendering fallback, not the default stored preference. */
export const DEFAULT_UI_LANGUAGE: UiLanguage = "en"
export const DEFAULT_UI_LANGUAGE_PREFERENCE: UiLanguagePreference = "auto"

export const UI_LANGUAGE_LABELS: Record<UiLanguage, string> = {
    en: "English",
    "zh-CN": "简体中文",
}

export function isUiLanguage(value: unknown): value is UiLanguage {
    return UI_LANGUAGES.some((language) => language === value)
}

/** Normalize a display value only; preferences must use normalizeUiLanguagePreference. */
export function normalizeUiLanguage(value: unknown): UiLanguage {
    return isUiLanguage(value) ? value : DEFAULT_UI_LANGUAGE
}

export function isUiLanguagePreference(value: unknown): value is UiLanguagePreference {
    return value === "auto" || isUiLanguage(value)
}

export function normalizeUiLanguagePreference(value: unknown): UiLanguagePreference {
    return isUiLanguagePreference(value) ? value : DEFAULT_UI_LANGUAGE_PREFERENCE
}

/** Resolve presentation from explicit preference or host metadata without writing either input. */
export function resolveUiLanguage(preference: unknown, hostLanguage?: string): UiLanguage {
    const normalizedPreference = normalizeUiLanguagePreference(preference)
    if (normalizedPreference !== "auto") return normalizedPreference

    return /^zh(?:[-_]|$)/i.test(hostLanguage ?? "") ? "zh-CN" : DEFAULT_UI_LANGUAGE
}
