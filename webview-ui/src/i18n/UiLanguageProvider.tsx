import { DEFAULT_UI_LANGUAGE, type UiLanguage } from "@shared/UiLanguage"
import { createContext, type ReactNode, useContext, useEffect, useMemo } from "react"
import { translateUi, type UiTranslator } from "./messages"

interface UiTranslation {
    language: UiLanguage
    t: UiTranslator
}

const UiLanguageContext = createContext<UiTranslation>({
    language: DEFAULT_UI_LANGUAGE,
    t: (key, ...args) => translateUi(DEFAULT_UI_LANGUAGE, key, ...args),
})

/** A controlled presentation context; the Settings owner remains the sole preference authority. */
export function UiLanguageProvider({ children, language }: { children: ReactNode; language: UiLanguage }) {
    const value = useMemo<UiTranslation>(
        () => ({ language, t: (key, ...args) => translateUi(language, key, ...args) }),
        [language],
    )

    return <UiLanguageContext.Provider value={value}>{children}</UiLanguageContext.Provider>
}

/** Mount once at the Webview root, not in nested stories or component previews. */
export function UiDocumentLanguage() {
    const { language } = useUiTranslation()
    useEffect(() => {
        document.documentElement.lang = language
    }, [language])
    return null
}

export function useUiTranslation(): UiTranslation {
    return useContext(UiLanguageContext)
}
