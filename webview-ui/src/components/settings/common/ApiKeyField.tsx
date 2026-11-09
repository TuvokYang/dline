import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useId } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ProfileField } from "../profile-ui"
import { useDebouncedInput } from "../utils/useDebouncedInput"
import { useTextFieldHost } from "../utils/useTextFieldHost"

/**
 * Props for the ApiKeyField component
 */
interface ApiKeyFieldProps {
    initialValue: string
    onChange: (value: string) => void | Promise<unknown>
    providerName: string
    signupUrl?: string
    placeholder?: string
    helpText?: string
}

/**
 * A reusable component for API key input fields with standard styling and help text for signing up for key
 */
export const ApiKeyField = ({ initialValue, onChange, providerName, signupUrl, placeholder, helpText }: ApiKeyFieldProps) => {
    const { t } = useUiTranslation()
    const [localValue, setLocalValue] = useDebouncedInput(initialValue, onChange)
    const inputId = useId()
    const label = t("settings.ui.apiKey", { provider: providerName })
    const textFieldHostProps = useTextFieldHost(label, localValue)

    return (
        <ProfileField
            description={
                <>
                    {helpText || t("settings.ui.keyHelp")}
                    {!localValue && signupUrl ? (
                        <>
                            {" "}
                            <VSCodeLink className="inline text-inherit" href={signupUrl}>
                                {t("settings.ui.signupKey", { provider: providerName })}
                            </VSCodeLink>
                        </>
                    ) : null}
                </>
            }
            htmlFor={inputId}
            label={label}>
            <VSCodeTextField
                {...textFieldHostProps}
                aria-label={label}
                className="min-h-7 w-full"
                id={inputId}
                onInput={(e: any) => setLocalValue(e.target.value)}
                placeholder={placeholder ?? t("settings.ui.enterApiKey")}
                required={true}
                type="password"
                value={localValue}
            />
        </ProfileField>
    )
}
