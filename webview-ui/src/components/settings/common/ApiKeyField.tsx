import { VSCodeLink, VSCodeTextField } from "@vscode/webview-ui-toolkit/react"
import { useId } from "react"
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
export const ApiKeyField = ({
    initialValue,
    onChange,
    providerName,
    signupUrl,
    placeholder = "Enter API Key...",
    helpText,
}: ApiKeyFieldProps) => {
    const [localValue, setLocalValue] = useDebouncedInput(initialValue, onChange)
    const inputId = useId()
    const label = `${providerName} API Key`
    const textFieldHostProps = useTextFieldHost(label, localValue)

    return (
        <ProfileField
            description={
                <>
                    {helpText || "This key is stored locally and only used to make API requests from this extension."}
                    {!localValue && signupUrl ? (
                        <>
                            {" "}
                            <VSCodeLink className="inline text-inherit" href={signupUrl}>
                                You can get a{/^[aeiou]/i.test(providerName) ? "n" : ""} {providerName} API key by signing up
                                here.
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
                placeholder={placeholder}
                required={true}
                type="password"
                value={localValue}
            />
        </ProfileField>
    )
}
