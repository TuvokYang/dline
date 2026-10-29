import { CLINE_PROVIDER_APP_URL } from "@shared/providers/cline-runtime"
import React, { useEffect, useState } from "react"
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
    cline: `${CLINE_PROVIDER_APP_URL}/dashboard/account?tab=credits&redirect=true`,
    deepseek: "https://platform.deepseek.com/top_up",
    openrouter: "https://openrouter.ai/credits",
}

const DLINE_ACCOUNT_APP_URL = "https://app.dline.cc"
const DLINE_ACCOUNT_BUY_CREDITS_URL = {
    USER: `${DLINE_ACCOUNT_APP_URL}/dashboard/account?tab=credits&redirect=true`,
    ORG: `${DLINE_ACCOUNT_APP_URL}/dashboard/organization?tab=credits&redirect=true`,
}

interface CreditLimitCardProps extends CreditLimitErrorProps {
    resolvedBuyCreditsUrl?: string
}

/** Retry and Start New Task belong to the task footer, so this card only links out. */
const CreditLimitCard: React.FC<CreditLimitCardProps> = ({
    message = "You have run out of credits.",
    currentBalance,
    resolvedBuyCreditsUrl,
    totalPromotions,
    totalSpent,
}) => (
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
                {totalPromotions ? <div className="text-foreground">Total Promotions: {totalPromotions.toFixed(2)}</div> : null}
            </div>
        </div>

        {resolvedBuyCreditsUrl ? (
            <VSCodeButtonLink className="w-full mb-2" href={resolvedBuyCreditsUrl}>
                <span className="codicon codicon-credit-card mr-[6px] text-[14px]" />
                Buy Credits
            </VSCodeButtonLink>
        ) : null}
    </div>
)

/** Dline Account owns its organization-aware callback flow; providers never enter this path. */
const DlineAccountCreditLimitError: React.FC<CreditLimitErrorProps> = (props) => {
    const { activeOrganization } = useClineAuth()
    const [buyCreditsUrl, setBuyCreditsUrl] = useState("")
    const dashboardUrl = activeOrganization?.organizationId
        ? DLINE_ACCOUNT_BUY_CREDITS_URL.ORG
        : DLINE_ACCOUNT_BUY_CREDITS_URL.USER

    useEffect(() => {
        const fetchCallbackUrl = async () => {
            try {
                const callbackUrl = (await AccountServiceClient.getRedirectUrl({})).value
                const url = new URL(dashboardUrl)
                url.searchParams.set("callback_url", callbackUrl)
                setBuyCreditsUrl(url.toString())
            } catch (error) {
                console.error("Error fetching callback URL:", error)
                setBuyCreditsUrl(dashboardUrl)
            }
        }
        void fetchCallbackUrl()
    }, [dashboardUrl])

    return <CreditLimitCard {...props} resolvedBuyCreditsUrl={buyCreditsUrl} />
}

const CreditLimitError: React.FC<CreditLimitErrorProps> = (props) => {
    const providerUrl = props.buyCreditsUrl ?? (props.providerId ? PROVIDER_RECHARGE_URLS[props.providerId] : undefined)

    if (!props.providerId && !props.buyCreditsUrl) {
        return <DlineAccountCreditLimitError {...props} />
    }

    return <CreditLimitCard {...props} resolvedBuyCreditsUrl={providerUrl} />
}

export default CreditLimitError
