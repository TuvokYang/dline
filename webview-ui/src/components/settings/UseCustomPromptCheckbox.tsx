import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import React, { useCallback, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { updateSetting } from "./utils/settingsHandlers"

interface CustomPromptCheckboxProps {
    providerId: string
}

/**
 * Checkbox to enable or disable the use of a compact prompt for local models providers.
 */
const UseCustomPromptCheckbox: React.FC<CustomPromptCheckboxProps> = ({ providerId }) => {
    const { t } = useUiTranslation()
    const { customPrompt } = useExtensionState()
    const [isCompactPromptEnabled, setIsCompactPromptEnabled] = useState<boolean>(customPrompt === "compact")

    const toggleCompactPrompt = useCallback((isChecked: boolean) => {
        setIsCompactPromptEnabled(isChecked)
        updateSetting("customPrompt", isChecked ? "compact" : "")
    }, [])

    return (
        <div id={providerId}>
            <VSCodeCheckbox checked={isCompactPromptEnabled} onChange={() => toggleCompactPrompt(!isCompactPromptEnabled)}>
                {t("settings.ui.compactPrompt")}
            </VSCodeCheckbox>
            <div className="text-xs text-description">
                {t("settings.ui.compactPromptHelp")}
                <div className="text-error flex align-middle">
                    <i className="codicon codicon-x" />
                    {t("settings.ui.compactPromptWarning")}
                </div>
            </div>
        </div>
    )
}

export default UseCustomPromptCheckbox
