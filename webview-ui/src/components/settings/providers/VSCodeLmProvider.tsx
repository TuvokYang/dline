// Mode import removed — no longer needed in profile-driven architecture

import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import type { ApiProfile } from "./ProviderProfile"

interface VSCodeLmProviderProps {
    showModelOptions?: boolean
    profile?: ApiProfile
    onUpdate?: (updates: Partial<ApiProfile>) => void
}

/** VS Code LM provider �?uses built-in VS Code language models. No API configuration needed. */
export const VSCodeLmProvider = ({}: VSCodeLmProviderProps) => {
    const { t } = useUiTranslation()
    return (
        <div>
            <p style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)" }}>{t("settings.ui.vscodeLm.help")}</p>
        </div>
    )
}
