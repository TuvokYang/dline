import { DEFAULT_TERMINAL_COMMAND_TIMEOUT_SECONDS } from "@shared/terminal-settings"
import { VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useCallback, useEffect, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { updateSetting } from "./utils/settingsHandlers"
import { useTextFieldHost } from "./utils/useTextFieldHost"

const TerminalCommandTimeoutSetting = () => {
	const { terminalCommandTimeoutSeconds } = useExtensionState()
	const timeoutSeconds = terminalCommandTimeoutSeconds ?? DEFAULT_TERMINAL_COMMAND_TIMEOUT_SECONDS
	const initialInputValue = String(timeoutSeconds / 60)
	const [inputValue, setInputValue] = useState(initialInputValue)
	const inputValueRef = useRef(initialInputValue)
	const [inputError, setInputError] = useState<string | null>(null)
	const [isEditing, setIsEditing] = useState(false)
	const isEditingRef = useRef(false)
	const textFieldHostProps = useTextFieldHost("Terminal command timeout (minutes)", inputValue, !isEditing)

	const setDraftValue = useCallback((value: string) => {
		inputValueRef.current = value
		setInputValue(value)
	}, [])

	useEffect(() => {
		if (!isEditingRef.current) {
			setDraftValue(String(timeoutSeconds / 60))
		}
	}, [setDraftValue, timeoutSeconds])

	const handleChange = (event: Event) => {
		const value = (event.target as HTMLInputElement).value
		if (!isEditingRef.current) {
			isEditingRef.current = true
			setIsEditing(true)
		}
		setDraftValue(value)

		const minutes = Number(value)
		if (!Number.isFinite(minutes) || minutes < 1) {
			setInputError("Enter at least 1 minute")
			return
		}

		setInputError(null)
	}

	const handleBlur = () => {
		isEditingRef.current = false
		setIsEditing(false)
		const minutes = Number(inputValueRef.current)
		if (!Number.isFinite(minutes) || minutes < 1) {
			setDraftValue(String(timeoutSeconds / 60))
			setInputError(null)
			return
		}

		const nextTimeoutSeconds = Math.round(minutes * 60)
		setDraftValue(String(nextTimeoutSeconds / 60))
		updateSetting("terminalCommandTimeoutSeconds", nextTimeoutSeconds)
	}

	return (
		<div className="mb-4">
			<label className="font-medium block mb-1" htmlFor="terminal-command-timeout">
				Terminal command timeout (minutes)
			</label>
			<VSCodeTextField
				{...textFieldHostProps}
				className="w-full"
				id="terminal-command-timeout"
				onBlur={handleBlur}
				onFocus={() => {
					isEditingRef.current = true
					setIsEditing(true)
				}}
				onInput={(event) => handleChange(event as unknown as Event)}
			/>
			{inputError && <div className="text-(--vscode-errorForeground) text-xs mt-1">{inputError}</div>}
			<p className="text-xs text-(--vscode-descriptionForeground) mt-1">
				Maximum runtime before Dline terminates a command. Minimum 1 minute.
			</p>
		</div>
	)
}

export default TerminalCommandTimeoutSetting
