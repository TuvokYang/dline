import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import VSCodeButtonLink from "../common/VSCodeButtonLink"
import { StyledCreditDisplay } from "./StyledCreditDisplay"

type CreditBalanceProps = {
    balance: number | null
    fetchCreditBalance: () => void
    creditUrl: URL
    lastFetchTime: number
    isLoading: boolean
}

export const CreditBalance = ({ balance, fetchCreditBalance, creditUrl, lastFetchTime, isLoading }: CreditBalanceProps) => {
    const { language, t } = useUiTranslation()
    // Only the presentation of the same instant follows the display language.
    const formatter = new Intl.DateTimeFormat(language === "zh-CN" ? "zh-CN" : "en-US", {
        hour: "numeric",
        minute: "2-digit",
        second: "2-digit",
    })

    return (
        <div
            className="w-full flex flex-col items-center"
            title={t("shell.account.credits.lastUpdated", { time: formatter.format(new Date(lastFetchTime)) })}>
            <div className="text-sm text-(--vscode-descriptionForeground) mb-3 font-azeret-mono font-light">
                {t("shell.account.credits.label")}
            </div>

            <div className="font-bold text-2xl mb-6 flex items-center gap-2">
                {balance === null ? <span>----</span> : <StyledCreditDisplay balance={balance} />}
                <VSCodeButton
                    appearance="icon"
                    className={`mt-1 ${isLoading ? "animate-spin" : ""}`}
                    disabled={isLoading}
                    onClick={fetchCreditBalance}>
                    <span className="codicon codicon-refresh" />
                </VSCodeButton>
            </div>

            <div className="w-full">
                <VSCodeButtonLink className="w-full" href={creditUrl.href}>
                    {t("shell.account.credits.add")}
                </VSCodeButtonLink>
            </div>
        </div>
    )
}
