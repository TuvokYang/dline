import { DEFAULT_TERMINAL_COMMAND_HANDOFF_SECONDS } from "@shared/terminal-settings"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "./utils/settingsHandlers"

const TerminalHandoffSecondsSetting = () => {
    const { terminalCommandHandoffSeconds } = useExtensionState()
    const handoffSeconds = terminalCommandHandoffSeconds ?? DEFAULT_TERMINAL_COMMAND_HANDOFF_SECONDS
    const [inputValue, setInputValue] = useState(String(handoffSeconds))
    const [inputError, setInputError] = useState<string | null>(null)

    useEffect(() => {
        setInputValue(String(handoffSeconds))
    }, [handoffSeconds])

    const handleChange = (event: Event) => {
        const value = (event.target as HTMLInputElement).value
        setInputValue(value)

        const seconds = Number(value)
        if (!Number.isSafeInteger(seconds) || seconds < 1) {
            setInputError("Enter at least 1 second")
            return
        }

        setInputError(null)
        updateSetting("terminalCommandHandoffSeconds", seconds)
    }

    return (
        <div className="mb-4">
            <label className="font-medium block mb-1" htmlFor="terminal-command-handoff">
                Foreground command handoff (seconds)
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
            {inputError && <div className="text-(--vscode-errorForeground) text-xs mt-1">{inputError}</div>}
            <p className="text-xs text-(--vscode-descriptionForeground) mt-1">
                How long a foreground command runs before Dline offers to move it to the background. Minimum 1 second.
            </p>
        </div>
    )
}

export default TerminalHandoffSecondsSetting
