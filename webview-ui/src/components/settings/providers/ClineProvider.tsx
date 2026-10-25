import { CLINE_PROVIDER_APP_URL, CLINE_PROVIDER_DEFAULT_API_BASE_URL } from "@shared/providers/cline-runtime"
import ClineModelPicker from "../ClineModelPicker"
import { ApiKeyField } from "../common/ApiKeyField"
import { DebouncedTextField } from "../common/DebouncedTextField"
import type { ApiProfile } from "./ProviderProfile"

/**
 * Props for the ClineProvider component
 */
interface ClineProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

/**
 * The Cline provider configuration component.
 * Delegates model selection to ClineModelPicker.
 */
export const ClineProvider = ({ showModelOptions, isPopup, profile, onUpdate }: ClineProviderProps) => {
    return (
        <div>
            <ApiKeyField
                initialValue={profile.apiKey}
                onChange={(apiKey) => onUpdate({ apiKey })}
                providerName="Cline Provider"
                signupUrl={CLINE_PROVIDER_APP_URL}
            />
            <DebouncedTextField
                initialValue={profile.baseUrl ?? ""}
                onChange={(baseUrl) => onUpdate({ baseUrl })}
                placeholder={CLINE_PROVIDER_DEFAULT_API_BASE_URL}
                style={{ width: "100%" }}>
                Cline Provider API Base URL
            </DebouncedTextField>

            {showModelOptions && (
                <ClineModelPicker isPopup={isPopup} onUpdate={onUpdate} profile={profile} showProviderRouting={true} />
            )}
        </div>
    )
}
