import { BooleanRequest, EmptyRequest } from "@shared/proto/dline/common"
import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { memo, useEffect, useState } from "react"
import DlineLogo from "@/assets/DlineLogo"
import ApiOptions from "@/components/settings/ApiOptions"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { UiText } from "@/i18n/UiText"
import { AccountServiceClient, StateServiceClient } from "@/services/grpc-client"
import { validateApiConfiguration } from "@/utils/validate"

/**
 * Legacy welcome surface retained for the states that still mount it.
 *
 * `apiErrorMessage` is a raw validation diagnostic; only the product-owned
 * wrappers around it are translated.
 */
const WelcomeView = memo(() => {
    const { t } = useUiTranslation()
    const { apiConfiguration, mode } = useExtensionState()
    const [apiErrorMessage, setApiErrorMessage] = useState<string | undefined>(undefined)
    const [showApiOptions, setShowApiOptions] = useState(false)
    const [isLoading, setIsLoading] = useState(false)

    const disableLetsGoButton = apiErrorMessage != null

    const handleLogin = () => {
        setIsLoading(true)
        AccountServiceClient.accountLoginClicked(EmptyRequest.create())
            .catch((err) => console.error("Failed to get login URL:", err))
            .finally(() => {
                setIsLoading(false)
            })
    }

    const handleSubmit = async () => {
        try {
            await StateServiceClient.setWelcomeViewCompleted(BooleanRequest.create({ value: true }))
        } catch (error) {
            console.error("Failed to update API configuration or complete welcome view:", error)
        }
    }

    useEffect(() => {
        setApiErrorMessage(validateApiConfiguration(mode, apiConfiguration, undefined, t))
    }, [apiConfiguration, mode, t])

    return (
        <div className="fixed inset-0 p-0 flex flex-col">
            <div className="h-full px-5 overflow-auto flex flex-col gap-2.5">
                <h2 className="text-lg font-semibold">{t("shell.welcome.legacy.intro")}</h2>
                <div className="flex justify-center my-5">
                    <DlineLogo className="size-16" color="white" />
                </div>
                <p>
                    <UiText
                        slots={{
                            model: (
                                <VSCodeLink className="inline" href="https://www.anthropic.com/claude/sonnet">
                                    {t("shell.welcome.legacy.modelLink")}
                                </VSCodeLink>
                            ),
                            permission: <i>{t("shell.welcome.legacy.permission")}</i>,
                        }}
                        text={t("shell.welcome.legacy.capability")}
                    />
                </p>

                <p className="text-(--vscode-descriptionForeground)">{t("shell.welcome.legacy.signUp")}</p>

                <VSCodeButton appearance="primary" className="w-full mt-1" disabled={isLoading} onClick={handleLogin}>
                    {t("shell.welcome.legacy.getStarted")}
                    {isLoading && (
                        <span className="ml-1 animate-spin">
                            <span className="codicon codicon-refresh" />
                        </span>
                    )}
                </VSCodeButton>

                {!showApiOptions && (
                    <VSCodeButton
                        appearance="secondary"
                        className="mt-2.5 w-full"
                        onClick={() => setShowApiOptions(!showApiOptions)}>
                        {t("shell.welcome.legacy.useOwnKey")}
                    </VSCodeButton>
                )}

                <div className="mt-4.5">
                    {showApiOptions && (
                        <div>
                            <ApiOptions currentMode={mode} showModelOptions={false} />
                            <VSCodeButton className="mt-0.75" disabled={disableLetsGoButton} onClick={handleSubmit}>
                                {t("shell.welcome.legacy.letsGo")}
                            </VSCodeButton>
                        </div>
                    )}
                </div>
            </div>
        </div>
    )
})

export default WelcomeView
