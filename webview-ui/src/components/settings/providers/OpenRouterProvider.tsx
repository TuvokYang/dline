import { EmptyRequest } from "@shared/proto/dline/common"
// Mode import removed — no longer needed in profile-driven architecture
import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { AccountServiceClient } from "@/services/grpc-client"
import { formatCurrencyAmount } from "@/utils/currency"
import { useOpenRouterKeyInfo } from "../../ui/hooks/useOpenRouterKeyInfo"
import { DebouncedTextField } from "../common/DebouncedTextField"
import OpenRouterModelPicker from "../OpenRouterModelPicker"
import type { ApiProfile } from "./ProviderProfile"

/** OpenRouter bills key credit in US dollars, independent of the selected model. */
const OPENROUTER_CREDIT_CURRENCY = "USD"

/**
 * Component to display OpenRouter balance information
 */
const OpenRouterBalanceDisplay = ({ apiKey }: { apiKey: string }) => {
    const { data: keyInfo, isLoading, error } = useOpenRouterKeyInfo(apiKey)

    if (isLoading) {
        return <span style={{ fontSize: "12px", color: "var(--vscode-descriptionForeground)" }}>Loading...</span>
    }

    if (error || !keyInfo || keyInfo.limit === null) {
        return null
    }

    const remainingBalance = keyInfo.limit - keyInfo.usage
    const formatCredit = (amount: number) => formatCurrencyAmount(amount, OPENROUTER_CREDIT_CURRENCY)
    const formattedBalance = formatCredit(remainingBalance)

    return (
        <VSCodeLink
            href="https://openrouter.ai/settings/keys"
            style={{
                fontSize: "12px",
                color: "var(--vscode-foreground)",
                textDecoration: "none",
                fontWeight: 500,
                paddingLeft: 4,
                cursor: "pointer",
            }}
            title={`Remaining balance: ${formattedBalance}\nLimit: ${formatCredit(keyInfo.limit)}\nUsage: ${formatCredit(keyInfo.usage)}`}>
            Balance: {formattedBalance}
        </VSCodeLink>
    )
}

/**
 * Props for the OpenRouterProvider component
 */
interface OpenRouterProviderProps {
    showModelOptions: boolean
    isPopup?: boolean
    profile: ApiProfile
    onUpdate: (updates: Partial<ApiProfile>) => void
}

/**
 * The OpenRouter provider configuration component.
 * All data sourced from ApiProfile.
 */
export const OpenRouterProvider = ({ showModelOptions, isPopup, profile, onUpdate }: OpenRouterProviderProps) => {
    const apiKey = profile.apiKey

    return (
        <div>
            <div>
                <DebouncedTextField
                    initialValue={apiKey}
                    onChange={(value) => onUpdate({ apiKey: value })}
                    placeholder="Enter API Key..."
                    style={{ width: "100%" }}
                    type="password">
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", width: "100%" }}>
                        <span style={{ fontWeight: 500 }}>OpenRouter API Key</span>
                        {apiKey && <OpenRouterBalanceDisplay apiKey={apiKey} />}
                    </div>
                </DebouncedTextField>
                {!apiKey && (
                    <VSCodeButton
                        appearance="secondary"
                        onClick={async () => {
                            try {
                                await AccountServiceClient.openrouterAuthClicked(EmptyRequest.create())
                            } catch (error) {
                                console.error("Failed to open OpenRouter auth:", error)
                            }
                        }}
                        style={{ margin: "5px 0 0 0" }}>
                        Get OpenRouter API Key
                    </VSCodeButton>
                )}
                <p
                    style={{
                        fontSize: "12px",
                        marginTop: "5px",
                        color: "var(--vscode-descriptionForeground)",
                    }}>
                    This key is stored locally and only used to make API requests from this extension.
                </p>
            </div>

            {showModelOptions && (
                <OpenRouterModelPicker isPopup={isPopup} onUpdate={onUpdate} profile={profile} showProviderRouting={true} />
            )}
        </div>
    )
}
