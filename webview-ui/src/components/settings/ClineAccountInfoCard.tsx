import { isFeatureSettingActive } from "@shared/DlineFeatureSettings"
import { EmptyRequest } from "@shared/proto/dline/common"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useState } from "react"
import { useClineAuth } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { AccountServiceClient } from "@/services/grpc-client"

export const ClineAccountInfoCard = () => {
    const { t } = useUiTranslation()
    const { clineUser } = useClineAuth()
    const { navigateToAccount, accountEnabled } = useExtensionState()
    const [isLoading, setIsLoading] = useState(false)

    // Sign-up and billing belong to the account feature, which the rollout may keep off.
    if (!isFeatureSettingActive(accountEnabled)) return null

    const user = clineUser || undefined

    const handleLogin = () => {
        setIsLoading(true)
        AccountServiceClient.accountLoginClicked(EmptyRequest.create())
            .catch((err) => console.error("Failed to get login URL:", err))
            .finally(() => {
                setIsLoading(false)
            })
    }

    const handleShowAccount = () => {
        navigateToAccount()
    }

    return (
        <div className="max-w-[600px]">
            {user ? (
                <VSCodeButton appearance="secondary" onClick={handleShowAccount}>
                    {t("settings.ui.account.billing")}
                </VSCodeButton>
            ) : (
                <div>
                    <VSCodeButton className="mt-0" disabled={isLoading} onClick={handleLogin}>
                        {t("settings.ui.account.signup")}
                        {isLoading && (
                            <span className="ml-1 animate-spin">
                                <span className="codicon codicon-refresh" />
                            </span>
                        )}
                    </VSCodeButton>
                </div>
            )}
        </div>
    )
}
