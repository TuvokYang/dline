import { resolveUiLanguage } from "@shared/UiLanguage"
import type { ReactNode } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { UiDocumentLanguage, UiLanguageProvider } from "./UiLanguageProvider"

/** Resolve from the final state context; previews can delegate document ownership to their leaf root. */
export function UiLanguageBridge({
    children,
    updateDocumentLanguage = true,
}: {
    children: ReactNode
    updateDocumentLanguage?: boolean
}) {
    const { uiLanguage, hostDisplayLanguage } = useExtensionState()
    return (
        <UiLanguageProvider language={resolveUiLanguage(uiLanguage, hostDisplayLanguage)}>
            {updateDocumentLanguage && <UiDocumentLanguage />}
            {children}
        </UiLanguageProvider>
    )
}
