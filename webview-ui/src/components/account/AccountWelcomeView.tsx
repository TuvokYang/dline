import { VSCodeButton, VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import { useClineSignIn } from "@/context/ClineAuthContext"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { UiText } from "@/i18n/UiText"
import DlineLogo from "../../assets/DlineLogo"

export const AccountWelcomeView = () => {
    const { t } = useUiTranslation()
    const { environment } = useExtensionState()
    const { isLoginLoading, handleSignIn } = useClineSignIn()

    return (
        <div className="flex flex-col items-center gap-2.5">
            <DlineLogo className="size-16 mb-4" environment={environment} />

            <p>{t("shell.account.welcome.description")}</p>

            <VSCodeButton className="w-full mb-4" disabled={isLoginLoading} onClick={handleSignIn}>
                {t("shell.account.welcome.signUp")}
                {isLoginLoading && (
                    <span className="ml-1 animate-spin">
                        <span className="codicon codicon-refresh" />
                    </span>
                )}
            </VSCodeButton>

            <p className="text-(--vscode-descriptionForeground) text-xs text-center m-0">
                <UiText
                    slots={{
                        terms: <VSCodeLink href="https://dline.cc/terms">{t("shell.account.welcome.terms")}</VSCodeLink>,
                        privacy: (
                            <VSCodeLink href="https://docs.dline.cc/privacy/">{t("shell.account.welcome.privacy")}</VSCodeLink>
                        ),
                    }}
                    text={t("shell.account.welcome.legal")}
                />
            </p>
        </div>
    )
}
