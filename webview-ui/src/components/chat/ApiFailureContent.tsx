import { memo, type ReactElement } from "react"
import CreditLimitError from "@/components/chat/CreditLimitError"
import SpendLimitError from "@/components/chat/SpendLimitError"
import { Button } from "@/components/ui/button"
import { useClineAuth, useClineSignIn } from "@/context/ClineAuthContext"
import { ClineError, ClineErrorType } from "../../../../src/services/error/ClineError"
import { ApiErrorBox } from "./ApiErrorBox"

interface ApiFailureContentProps {
    /** The failure as the task recorded it, usually a serialized provider error. */
    readonly error?: string
    readonly testId?: string
    readonly title?: string
    /** The surrounding interaction offers Retry in its footer, so the content must not add its own. */
    readonly footerOwnsRetry?: boolean
}

/**
 * One API failure, in the form the user can act on.
 *
 * An account limit names what to top up or wait out, and a signed-out Dline
 * account offers sign-in; anything else is the structured error box. The chat's
 * error rows and the interaction that offers Retry both render through it, so
 * a failure reads the same wherever it surfaces. Only the views that depend on
 * the Dline account (balance and sign-in) read the auth context.
 */
export const ApiFailureContent = memo(({ error, testId, title, footerOwnsRetry = false }: ApiFailureContentProps) => {
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
                showRetry={!footerOwnsRetry}
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

    if (clineError?.isErrorType(ClineErrorType.Auth) && providerId === "cline") return <ClineSignInPrompt fallback={box} />

    return box
})

/** Offer sign-in for a Dline provider failure while the account is signed out. */
function ClineSignInPrompt({ fallback }: { readonly fallback: ReactElement }) {
    const { clineUser } = useClineAuth()
    const { isLoginLoading, handleSignIn } = useClineSignIn()
    if (clineUser) return fallback
    return (
        <div className="flex flex-col gap-3">
            <div className="flex items-center justify-center rounded border border-neutral-500/30 bg-vscode-editor-background p-6 text-center text-vscode-foreground">
                Whoops looks like you're logged out – click below to sign in
            </div>
            <Button className="w-full" disabled={isLoginLoading} onClick={handleSignIn}>
                Sign in to Dline
                {isLoginLoading && (
                    <span className="ml-1 animate-spin">
                        <span className="codicon codicon-refresh" />
                    </span>
                )}
            </Button>
        </div>
    )
}
