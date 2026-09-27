import { UiMessage } from "@shared/ExtensionMessage"
import { memo } from "react"
import CreditLimitError from "@/components/chat/CreditLimitError"
import SpendLimitError from "@/components/chat/SpendLimitError"
import { Button } from "@/components/ui/button"
import { useClineAuth, useClineSignIn } from "@/context/ClineAuthContext"
import { ClineError, ClineErrorType } from "../../../../src/services/error/ClineError"
import { ApiErrorBox } from "./ApiErrorBox"

interface ErrorRowProps {
	message: UiMessage
	errorType: "error" | "mistake_limit_reached" | "diff_error" | "clineignore_error"
	apiRequestFailedMessage?: string
	apiReqStreamingFailedMessage?: string
}

const ErrorRow = memo(({ message, errorType, apiRequestFailedMessage, apiReqStreamingFailedMessage }: ErrorRowProps) => {
	const { clineUser } = useClineAuth()
	const rawApiError = apiRequestFailedMessage || apiReqStreamingFailedMessage

	const { isLoginLoading, handleSignIn } = useClineSignIn()

	const renderErrorContent = () => {
		switch (errorType) {
			case "error":
			case "mistake_limit_reached":
				if (rawApiError) {
					const clineError = ClineError.parse(rawApiError)
					const errorMessage = clineError?._error?.message || clineError?.message || rawApiError
					const providerId = clineError?.providerId || clineError?._error?.providerId
					const isClineProvider = providerId === "cline"

					if (clineError?.isErrorType(ClineErrorType.Balance)) {
						const errorDetails = clineError._error?.details
						return (
							<CreditLimitError
								buyCreditsUrl={errorDetails?.buy_credits_url}
								currentBalance={errorDetails?.current_balance}
								message={errorDetails?.message}
								providerId={providerId || clineError?.providerId}
								totalPromotions={errorDetails?.total_promotions}
								totalSpent={errorDetails?.total_spent}
							/>
						)
					}

					if (clineError?.isErrorType(ClineErrorType.SpendLimit)) {
						const d = clineError._error?.details
						return (
							<SpendLimitError
								budgetPeriod={d?.budget_period}
								limitUsd={d?.limit_usd}
								message={d?.message || errorMessage}
								resetsAt={d?.resets_at}
								spentUsd={d?.spent_usd}
							/>
						)
					}

					if (clineError?.isErrorType(ClineErrorType.Auth) && isClineProvider && !clineUser) {
						return (
							// User is using Cline provider and is not logged in
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

					return <ApiErrorBox error={rawApiError} />
				}

				return (
					<ApiErrorBox
						error={message.text}
						testId="error-message-box"
						title={errorType === "mistake_limit_reached" ? "Task Needs Attention" : "Error"}
					/>
				)

			case "diff_error":
				return (
					<div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
						<div>The model used search patterns that don't match anything in the file. Retrying...</div>
					</div>
				)

			case "clineignore_error":
				return (
					<div className="flex flex-col p-2 rounded text-xs opacity-80 bg-quote text-foreground">
						<div>
							Dline tried to access <code>{message.text}</code> which is blocked by the <code>.agentignore</code>
							file.
						</div>
					</div>
				)

			default:
				return null
		}
	}

	// For diff_error and clineignore_error, we don't show the header separately
	if (errorType === "diff_error" || errorType === "clineignore_error") {
		return renderErrorContent()
	}

	// For other error types, show header + content
	return renderErrorContent()
})

export default ErrorRow
