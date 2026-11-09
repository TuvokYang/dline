import { VSCodeCheckbox, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
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
    enabled?: boolean
    onEnabledChange?: (enabled: boolean) => void
}

/**
 * A reusable component for toggling and entering custom base URLs
 */
export const BaseUrlField = ({
    initialValue,
    onChange,
    label,
    placeholder,
    disabled = false,
    showLockIcon = false,
    enabled,
    onEnabledChange,
}: BaseUrlFieldProps) => {
    const { t } = useUiTranslation()
    const displayLabel = label ?? t("settings.ui.customBaseUrl")
    const [localEnabled, setIsEnabled] = useState(!!initialValue)
    const isEnabled = enabled ?? localEnabled
    const [localValue, setLocalValue] = useDebouncedInput(initialValue || "", onChange)

    const handleToggle = (e: any) => {
        const checked = e.target.checked === true
        setIsEnabled(checked)
        onEnabledChange?.(checked)
        if (!checked) {
            setLocalValue("")
        }
    }

    return (
        <div className="flex min-w-0 flex-col gap-1">
            <div className="flex min-w-0 items-center gap-2">
                <VSCodeCheckbox checked={isEnabled} className="text-sm" disabled={disabled} onChange={handleToggle}>
                    {displayLabel}
                </VSCodeCheckbox>
                {showLockIcon && <i className="codicon codicon-lock text-(--vscode-descriptionForeground) text-sm" />}
            </div>

            {isEnabled ? (
                <VSCodeTextField
                    aria-label={label ?? t("settings.ui.baseUrl")}
                    className="min-h-7 w-full"
                    disabled={disabled}
                    onInput={(e: any) => setLocalValue(e.target.value.trim())}
                    placeholder={placeholder ?? t("settings.ui.defaultValue", { value: "https://api.example.com" })}
                    type="text"
                    value={localValue}
                />
            ) : null}
        </div>
    )
}
