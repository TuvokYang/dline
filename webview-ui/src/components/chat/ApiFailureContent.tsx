import { memo } from "react"
import CreditLimitError from "@/components/chat/CreditLimitError"
import SpendLimitError from "@/components/chat/SpendLimitError"
import { ClineError, ClineErrorType } from "../../../../src/services/error/ClineError"
import { ApiErrorBox } from "./ApiErrorBox"

interface ApiFailureContentProps {
    /** The failure as the task recorded it, usually a serialized provider error. */
    readonly error?: string
    readonly testId?: string
    readonly title?: string
}

/**
 * One API failure, in the form the user can act on.
 *
 * Provider balance and spend limits name what to top up or wait out; any other
 * failure remains the structured provider error. The chat's error rows and the
 * interaction that offers Retry both render through this boundary, so a failure
 * reads the same wherever it surfaces. Retry and Start New Task belong to the
 * task footer; this content only links out.
 */
export const ApiFailureContent = memo(({ error, testId, title }: ApiFailureContentProps) => {
    const clineError = error ? ClineError.parse(error) : undefined
    const box = <ApiErrorBox error={error} testId={testId} title={title} />
    const providerId = clineError?.providerId || clineError?._error?.providerId

    if (clineError?.isErrorType(ClineErrorType.Balance)) {
        const details = clineError._error?.details
        return (
            <CreditLimitError
                buyCreditsUrl={details?.buy_credits_url}
                currentBalance={details?.current_balance}
                message={details?.message}
                providerId={providerId}
                totalPromotions={details?.total_promotions}
                totalSpent={details?.total_spent}
            />
        )
    }

    if (clineError?.isErrorType(ClineErrorType.SpendLimit)) {
        const details = clineError._error?.details
        return (
            <SpendLimitError
                budgetPeriod={details?.budget_period}
                limitUsd={details?.limit_usd}
                message={details?.message || clineError._error?.message || clineError.message || error}
                resetsAt={details?.resets_at}
                spentUsd={details?.spent_usd}
            />
        )
    }

    return box
})
