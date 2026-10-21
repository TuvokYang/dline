import React, { useEffect, useMemo, useState } from "react"
import VSCodeButtonLink from "@/components/common/VSCodeButtonLink"
import { useClineAuth } from "@/context/ClineAuthContext"
import { AccountServiceClient } from "@/services/grpc-client"

interface CreditLimitErrorProps {
    currentBalance: number
    totalSpent?: number
    totalPromotions?: number
    message: string
    buyCreditsUrl?: string
    providerId?: string
}

/**
 * Provider-specific recharge/billing URLs.
 * When adding a new provider, add its top-up URL here so users can buy credits directly.
 */
const PROVIDER_RECHARGE_URLS: Record<string, string> = {
    cline: "https://app.dline.bot/dashboard/account?tab=credits&redirect=true",
    deepseek: "https://platform.deepseek.com/top_up",
    openrouter: "https://openrouter.ai/credits",
}

const DEFAULT_BUY_CREDITS_URL = {
    USER: "https://app.dline.bot/dashboard/account?tab=credits&redirect=true",
    ORG: "https://app.dline.bot/dashboard/organization?tab=credits&redirect=true",
}

/**
 * The account-limit card offers only what leaves the task: buying credits.
 * Retry and Start New Task answer the failure interaction, which the task
 * footer owns, so the card never repeats them.
 */
const CreditLimitError: React.FC<CreditLimitErrorProps> = ({
    message = "You have run out of credits.",
    buyCreditsUrl,
    currentBalance,
    providerId,
    totalPromotions,
    totalSpent,
}) => {
    const { activeOrganization } = useClineAuth()
    const [fullBuyCreditsUrl, setFullBuyCreditsUrl] = useState<string>("")

    /**
     * Determine the recharge URL based on priority:
     * 1. Explicit buyCreditsUrl from error details (backend-provided)
     * 2. Provider-specific URL from PROVIDER_RECHARGE_URLS map
     * 3. Default Cline URLs (ORG vs USER based on active organization)
     */
    const dashboardUrl = useMemo(() => {
        if (buyCreditsUrl) {
            return buyCreditsUrl
        }
        if (providerId && PROVIDER_RECHARGE_URLS[providerId]) {
            return PROVIDER_RECHARGE_URLS[providerId]
        }
        // Fallback for cline provider or unknown providers
        return activeOrganization?.organizationId ? DEFAULT_BUY_CREDITS_URL.ORG : DEFAULT_BUY_CREDITS_URL.USER
    }, [buyCreditsUrl, providerId, activeOrganization?.organizationId])

    /**
     * Only fetch callback URL for cline.bot links (they support callback redirect).
     * For third-party provider recharge pages, use the URL directly.
     */
    const isClineUrl = dashboardUrl.includes("app.dline.bot")

    useEffect(() => {
        if (isClineUrl) {
            const fetchCallbackUrl = async () => {
                try {
                    const callbackUrl = (await AccountServiceClient.getRedirectUrl({})).value
                    const url = new URL(dashboardUrl)
                    url.searchParams.set("callback_url", callbackUrl)
                    setFullBuyCreditsUrl(url.toString())
                } catch (error) {
                    console.error("Error fetching callback URL:", error)
                    // Fallback to URL without callback if the API call fails
                    setFullBuyCreditsUrl(dashboardUrl)
                }
            }
            fetchCallbackUrl()
        } else {
            setFullBuyCreditsUrl(dashboardUrl)
        }
    }, [dashboardUrl, isClineUrl])

    // We have to divide because the balance is stored in microcredits
    return (
        <div className="p-2 border-none rounded-md mb-2 bg-(--vscode-textBlockQuote-background)">
            <div className="mb-3 font-azeret-mono">
                <div className="text-error mb-2">{message}</div>
                <div className="mb-3">
                    {currentBalance ? (
                        <div className="text-foreground">
                            Current Balance: <span className="font-bold">{currentBalance.toFixed(2)}</span>
                        </div>
                    ) : null}
                    {totalSpent ? <div className="text-foreground">Total Spent: {totalSpent.toFixed(2)}</div> : null}
                    {totalPromotions ? (
                        <div className="text-foreground">Total Promotions: {totalPromotions.toFixed(2)}</div>
                    ) : null}
                </div>
            </div>

            <VSCodeButtonLink className="w-full mb-2" href={fullBuyCreditsUrl}>
                <span className="codicon codicon-credit-card mr-[6px] text-[14px]" />
                Buy Credits
            </VSCodeButtonLink>
        </div>
    )
}

export default CreditLimitError
