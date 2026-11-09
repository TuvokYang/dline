import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import React, { useEffect, useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { AccountServiceClient } from "@/services/grpc-client"

const COOLDOWN_MS = 5 * 60 * 1000 // 5 minutes
const COOLDOWN_KEY = "cline:spendLimitRequestCooldown"

type RequestButtonState = "idle" | "sending" | "sent"

function formatResetsAt(resetsAt?: string): string | null {
    if (!resetsAt) return null
    try {
        const date = new Date(resetsAt)
        if (Number.isNaN(date.getTime())) return null
        return date.toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
        })
    } catch {
        return null
    }
}

interface SpendLimitErrorProps {
    /** Human-readable error message from the backend */
    message: string
    /** Which period the limit applies to: "daily" | "monthly" */
    budgetPeriod?: string
    /** The configured spend limit in USD */
    limitUsd?: number
    /** How much the user has spent in USD this period */
    spentUsd?: number
    /** ISO 8601 timestamp of when the limit resets (may be null for monthly) */
    resetsAt?: string
}

const SpendLimitError: React.FC<SpendLimitErrorProps> = ({ message, budgetPeriod, limitUsd, spentUsd, resetsAt }) => {
    const { t } = useUiTranslation()
    const periodKey =
        budgetPeriod === "daily"
            ? "chatRows.errors.budgetPeriod.daily"
            : budgetPeriod === "monthly"
              ? "chatRows.errors.budgetPeriod.monthly"
              : undefined
    // A period the product does not name stays as the backend sent it rather than
    // being guessed from its English spelling.
    const periodLabel = periodKey ? t(periodKey) : budgetPeriod
    const displayMessage =
        limitUsd != null && budgetPeriod
            ? t("chatRows.errors.spendLimitMessage", { limit: limitUsd.toFixed(2), period: periodLabel ?? budgetPeriod })
            : message

    const [buttonState, setButtonState] = useState<RequestButtonState>(() => {
        try {
            const ts = localStorage.getItem(COOLDOWN_KEY)
            if (ts && Date.now() - Number(ts) < COOLDOWN_MS) return "sent"
        } catch {
            // localStorage may not be available in some environments
        }
        return "idle"
    })

    // Reset button to idle once cooldown expires
    useEffect(() => {
        if (buttonState !== "sent") return
        try {
            const ts = localStorage.getItem(COOLDOWN_KEY)
            if (!ts) {
                setButtonState("idle")
                return
            }
            const remaining = COOLDOWN_MS - (Date.now() - Number(ts))
            if (remaining <= 0) {
                setButtonState("idle")
                return
            }
            const timer = setTimeout(() => setButtonState("idle"), remaining)
            return () => clearTimeout(timer)
        } catch {
            // Ignore localStorage errors
        }
    }, [buttonState])

    const handleRequestIncrease = async () => {
        setButtonState("sending")
        try {
            await AccountServiceClient.submitLimitIncreaseRequest({})
            localStorage.setItem(COOLDOWN_KEY, String(Date.now()))
            setButtonState("sent")
        } catch (error) {
            console.error("Failed to submit limit increase request:", error)
            setButtonState("idle")
        }
    }

    const resetsAtFormatted = formatResetsAt(resetsAt)

    return (
        <div className="border-none rounded-md mb-2 bg-(--vscode-textBlockQuote-background)" style={{ padding: "10px 12px" }}>
            <div className="mb-3">
                <div className="text-error mb-2" style={{ fontSize: "calc(var(--vscode-font-size) + 2px)" }}>
                    {displayMessage}
                </div>

                <div className="mb-3">
                    {spentUsd != null && limitUsd != null && (
                        <div className="text-foreground" style={{ fontSize: "var(--vscode-font-size)", lineHeight: 1.3 }}>
                            {t("chatRows.errors.usage", { period: periodLabel ?? "" })}:{" "}
                            <span className="font-bold">
                                ${spentUsd.toFixed(2)} / ${limitUsd.toFixed(2)}
                            </span>
                        </div>
                    )}

                    {resetsAtFormatted && (
                        <div className="text-foreground" style={{ fontSize: "var(--vscode-font-size)", lineHeight: 1.3 }}>
                            {t("chatRows.errors.resets")} <span className="font-bold">{resetsAtFormatted}</span>
                        </div>
                    )}

                    <div className="text-(--vscode-descriptionForeground) mt-2 text-xs inline-flex items-center">
                        <span className="codicon codicon-organization mr-1" />
                        {t("chatRows.errors.organizationLimits")}
                    </div>
                </div>
            </div>

            <VSCodeButton
                appearance="primary"
                className="w-full"
                disabled={buttonState !== "idle"}
                onClick={handleRequestIncrease}>
                {buttonState === "sending" ? (
                    <>
                        <span className="codicon codicon-loading codicon-modifier-spin mr-1.5" />
                        {t("chatRows.errors.sending")}
                    </>
                ) : buttonState === "sent" ? (
                    <>
                        <span className="codicon codicon-check mr-1.5" />
                        {t("chatRows.errors.requestSent")}
                    </>
                ) : (
                    <>
                        <span className="codicon codicon-arrow-up mr-1.5" />
                        {t("chatRows.errors.requestIncrease")}
                    </>
                )}
            </VSCodeButton>
        </div>
    )
}

export default SpendLimitError
