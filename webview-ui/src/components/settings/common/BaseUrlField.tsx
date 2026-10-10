import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useDebouncedInput } from "../utils/useDebouncedInput"

/**
 * Props for the BaseUrlField component
 */
interface BaseUrlFieldProps {
    initialValue: string | undefined
    onChange: (value: string) => void | Promise<unknown>
    defaultValue?: string
    label?: string
    placeholder?: string
    disabled?: boolean
    showLockIcon?: boolean
}

/**
 * A reusable component for toggling and entering custom base URLs
 */
export const BaseUrlField = ({
    initialValue,
    onChange,
    label = "Use custom base URL",
    placeholder = "Default: https://api.example.com",
    disabled = false,
    showLockIcon = false,
}: BaseUrlFieldProps) => {
    const [isEnabled, setIsEnabled] = useState(!!initialValue)
    const [localValue, setLocalValue] = useDebouncedInput(initialValue || "", onChange)

    const handleToggle = (e: any) => {
        const checked = e.target.checked === true
        setIsEnabled(checked)
        if (!checked) {
            setLocalValue("")
        }
    }

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
                <VSCodeCheckbox checked={isEnabled} className="text-sm" disabled={disabled} onChange={handleToggle}>
                    {label}
                </VSCodeCheckbox>
                {showLockIcon && <i className="codicon codicon-lock text-(--vscode-descriptionForeground) text-sm" />}
            </div>

            {isEnabled ? (
                <VSCodeTextField
                    aria-label={label.replace(/^Use /, "")}
                    className="min-h-7 w-full"
                    disabled={disabled}
                    onInput={(e: any) => setLocalValue(e.target.value.trim())}
                    placeholder={placeholder}
                    type="text"
                    value={localValue}
                />
            ) : null}
        </div>
    )
}
