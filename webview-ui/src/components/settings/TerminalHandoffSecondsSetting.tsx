import { DEFAULT_TERMINAL_COMMAND_HANDOFF_SECONDS } from "@shared/terminal-settings"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { updateSetting } from "./utils/settingsHandlers"

const TerminalHandoffSecondsSetting = () => {
    const { t } = useUiTranslation()
    const { terminalCommandHandoffSeconds } = useExtensionState()
    const handoffSeconds = terminalCommandHandoffSeconds ?? DEFAULT_TERMINAL_COMMAND_HANDOFF_SECONDS
    const [inputValue, setInputValue] = useState(String(handoffSeconds))
    const [inputError, setInputError] = useState<boolean | null>(null)

    useEffect(() => {
        setInputValue(String(handoffSeconds))
    }, [handoffSeconds])

    const handleChange = (event: Event) => {
        const value = (event.target as HTMLInputElement).value
        setInputValue(value)

        const seconds = Number(value)
        if (!Number.isSafeInteger(seconds) || seconds < 1) {
            setInputError(true)
            return
        }

        setInputError(null)
        updateSetting("terminalCommandHandoffSeconds", seconds)
    }

    return (
        <div className="mb-4">
            <label className="font-medium block mb-1" htmlFor="terminal-command-handoff">
                {t("settings.ui.terminal.handoff")}
            </label>
            <VSCodeTextField
                className="w-full"
                id="terminal-command-handoff"
                onBlur={() => {
                    if (inputError) {
                        setInputValue(String(handoffSeconds))
                        setInputError(null)
                    }
                }}
                onInput={(event) => handleChange(event as unknown as Event)}
                value={inputValue}
            />
            {inputError && (
                <div className="text-(--vscode-errorForeground) text-xs mt-1">{t("settings.ui.terminal.secondInvalid")}</div>
            )}
            <p className="text-xs text-(--vscode-descriptionForeground) mt-1">{t("settings.ui.terminal.handoffHelp")}</p>
        </div>
    )
}

export default TerminalHandoffSecondsSetting
