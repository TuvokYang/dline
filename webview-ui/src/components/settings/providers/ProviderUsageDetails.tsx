import type { AccountUsageData, AccountUsageQuotaData } from "@shared/ExtensionMessage"
import type { AccountUsageResetResult } from "@shared/proto/dline/account"
import { TriangleAlertIcon } from "lucide-react"
import { useState } from "react"
import {
	AlertDialog,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/common/AlertDialog"

export type ProviderUsageProgressTone = "success" | "warning" | "caution" | "danger"

export function formatProviderUsageCurrency(currency: string | undefined, amount: number): string {
	const code = (currency || "USD").toUpperCase()
	if (code === "CNY") return `￥${amount.toFixed(2)}`
	try {
		return new Intl.NumberFormat(undefined, {
			style: "currency",
			currency: code,
			currencyDisplay: "narrowSymbol",
			minimumFractionDigits: 2,
			maximumFractionDigits: 2,
		}).format(amount)
	} catch {
		return `${code} ${amount.toFixed(2)}`
	}
}

/**
 * Report whether a quota carries a percentage that can be shown.
 *
 * A quota missing a usable bound or reading says nothing about the account, and
 * `Math.min`/`Math.max` propagate NaN rather than clamping it. Reporting such a
 * quota as 0% would claim it is exhausted, so callers drop it instead of
 * turning missing data into a definite state.
 */
export function isReadableUsageQuota(quota: AccountUsageQuotaData): boolean {
	return Number.isFinite(quota.limit) && quota.limit > 0 && Number.isFinite(quota.used)
}

export function usageRemainingPercent(quota: AccountUsageQuotaData): number {
	if (!isReadableUsageQuota(quota)) return 0
	return Math.max(0, Math.min(100, ((quota.limit - quota.used) / quota.limit) * 100))
}

export function usageUsedPercent(quota: AccountUsageQuotaData): number {
	return 100 - usageRemainingPercent(quota)
}

export function selectEffectiveUsageQuota(quotas: readonly AccountUsageQuotaData[]): AccountUsageQuotaData | undefined {
	return quotas.filter(isReadableUsageQuota).sort((left, right) => {
		const remainingDifference = usageRemainingPercent(left) - usageRemainingPercent(right)
		if (remainingDifference !== 0) return remainingDifference
		if (left.type === "5hour") return -1
		if (right.type === "5hour") return 1
		return 0
	})[0]
}

export function providerUsageProgressTone(remainingPercent: number): ProviderUsageProgressTone {
	if (remainingPercent <= 0) return "danger"
	if (remainingPercent < 20) return "caution"
	if (remainingPercent <= 40) return "warning"
	return "success"
}

export function providerUsageRemainingLabel(quota: AccountUsageQuotaData): string {
	return `${quota.label} ${usageRemainingPercent(quota).toFixed(0)}%`
}

function progressColor(tone: ProviderUsageProgressTone): string {
	switch (tone) {
		case "danger":
			return "var(--vscode-charts-red, #ef4444)"
		case "warning":
			return "var(--vscode-charts-yellow, #eab308)"
		case "caution":
			return "var(--vscode-charts-orange, #f59e0b)"
		default:
			return "var(--vscode-charts-green, #22c55e)"
	}
}

export function ProviderUsageProgressBar({ quota }: { quota: AccountUsageQuotaData }) {
	const remainingPercent = usageRemainingPercent(quota)
	const tone = providerUsageProgressTone(remainingPercent)
	return (
		<div
			aria-label={`${quota.label} usage`}
			aria-valuemax={100}
			aria-valuemin={0}
			aria-valuenow={remainingPercent}
			className="h-1.5 overflow-hidden rounded-full bg-editor-widget-border/60"
			data-usage-tone={tone}
			role="progressbar">
			<div
				className="h-full rounded-full transition-[width]"
				style={{ backgroundColor: progressColor(tone), width: `${remainingPercent}%` }}
			/>
		</div>
	)
}

function formatTime(value: string | undefined): string | undefined {
	if (!value) return undefined
	const date = new Date(value)
	return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString()
}

function resetResultMessage(outcome: string, quotaTypesReset: readonly string[]): string {
	switch (outcome) {
		case "reset":
			return quotaTypesReset.length > 0
				? `Reset completed for ${quotaTypesReset.join(" and ")}.`
				: "Eligible rate limits were reset."
		case "nothing_to_reset":
			return "No rate limit currently needs to be reset."
		case "no_credit":
			return "No reset card is available."
		case "already_redeemed":
			return "This reset request was already redeemed."
		default:
			return "The reset request returned an unknown result."
	}
}

export interface ProviderUsageDetailsProps {
	readonly usage: AccountUsageData
	readonly resetting: boolean
	readonly resetError?: string
	readonly showResetActions?: boolean
	readonly resetCreditsDisplay?: "full" | "summary"
	readonly consumeResetCredit: (creditId: string) => Promise<AccountUsageResetResult | undefined>
}

/** Provider-neutral quota, progress, and reset-credit renderer. */
export function ProviderUsageDetails({
	usage,
	resetting,
	resetError,
	showResetActions = true,
	resetCreditsDisplay = "full",
	consumeResetCredit,
}: ProviderUsageDetailsProps) {
	const [selectedCreditId, setSelectedCreditId] = useState<string>()
	const [resultMessage, setResultMessage] = useState<string>()
	const resetCredits = usage.resetCredits ?? []
	const nextResetCredit = resetCredits[0]
	const selectedCredit = resetCredits.find((credit) => credit.id === selectedCreditId)
	const supportsResetCredits = usage.resetCredits !== undefined || usage.resetCreditsAvailableCount !== undefined

	const consumeReset = async () => {
		if (!selectedCreditId) return
		const result = await consumeResetCredit(selectedCreditId)
		if (!result) return
		setResultMessage(resetResultMessage(result.outcome, result.quotaTypesReset))
		setSelectedCreditId(undefined)
	}

	return (
		<>
			<div className="flex flex-col gap-2 text-xs">
				{usage.planType ? (
					<div className="flex items-center justify-between gap-2">
						<span className="text-description">Plan</span>
						<span className="font-medium text-foreground">{usage.planType}</span>
					</div>
				) : null}
				{!usage.planType && usage.remainingBalance !== undefined ? (
					<div className="flex items-center justify-between gap-2">
						<span className="text-description">Balance</span>
						<span className="font-medium text-foreground">
							{formatProviderUsageCurrency(usage.currency, usage.remainingBalance)}
						</span>
					</div>
				) : null}
				{usage.dailyInputTokens !== undefined || usage.dailyOutputTokens !== undefined ? (
					<div className="grid grid-cols-2 gap-2 text-description">
						<span>Today In: {usage.dailyInputTokens ?? 0}</span>
						<span>Today Out: {usage.dailyOutputTokens ?? 0}</span>
					</div>
				) : null}
				{usage.quotas?.map((quota) => {
					const resetAt = formatTime(quota.resetAt)
					return (
						<div className="flex flex-col gap-1" key={`${quota.type}:${quota.label}`}>
							<div className="flex items-center justify-between gap-2">
								<span>{quota.label}</span>
								<span className="font-medium text-foreground">
									{usageRemainingPercent(quota).toFixed(0)}% remaining
								</span>
							</div>
							<ProviderUsageProgressBar quota={quota} />
							{resetAt ? <span className="whitespace-nowrap text-description">Resets {resetAt}</span> : null}
						</div>
					)
				})}
				{supportsResetCredits ? (
					<div className="mt-1 flex flex-col gap-1.5 border-t border-editor-widget-border/50 pt-2">
						<span className="font-medium text-foreground">
							Reset cards: {usage.resetCreditsAvailableCount ? usage.resetCreditsAvailableCount : "none"}
						</span>
						{resetCredits.length > 0 && resetCreditsDisplay === "summary" ? (
							<div className="flex flex-col gap-0.5 text-description">
								<span>Next card expires</span>
								<span className="whitespace-nowrap">
									{nextResetCredit?.expiresAt ? formatTime(nextResetCredit.expiresAt) : "Expiry unavailable"}
								</span>
							</div>
						) : resetCredits.length > 0 ? (
							<ul className="m-0 flex list-none flex-col gap-1 p-0">
								{resetCredits.map((credit, index) => {
									const expiresAt = formatTime(credit.expiresAt)
									return (
										<li
											className="flex min-w-0 items-center justify-between gap-2 rounded-xs bg-toolbar-hover/30 px-2 py-1.5"
											key={credit.id}>
											<div className="min-w-0" data-reset-credit-copy>
												<span className="block font-medium text-foreground">Reset card {index + 1}</span>
												<span className="block whitespace-nowrap text-description">
													{expiresAt ? `Expires ${expiresAt}` : "Expiry unavailable"}
												</span>
											</div>
											{showResetActions ? (
												<button
													aria-label={`Use reset card ${index + 1}`}
													className="inline-flex min-h-7 shrink-0 items-center rounded-xs border border-error/70 bg-error/15 px-2 font-medium text-error hover:bg-error/25 disabled:opacity-50"
													disabled={resetting}
													onClick={() => {
														setResultMessage(undefined)
														setSelectedCreditId(credit.id)
													}}
													type="button">
													Use card
												</button>
											) : null}
										</li>
									)
								})}
							</ul>
						) : (
							<span className="text-description">No available reset cards.</span>
						)}
					</div>
				) : null}
				{resetError ? (
					<div className="text-error" role="alert">
						{resetError}
					</div>
				) : null}
				{resultMessage ? (
					<div className="text-description" role="status">
						{resultMessage}
					</div>
				) : null}
			</div>
			<AlertDialog
				onOpenChange={(open) => !open && !resetting && setSelectedCreditId(undefined)}
				open={selectedCreditId !== undefined}>
				<AlertDialogContent aria-label="Use a rate-limit reset card?">
					<AlertDialogHeader>
						<AlertDialogTitle>
							<TriangleAlertIcon className="size-5 text-editor-warning-foreground" />
							Use a rate-limit reset card?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This consumes the selected reset card and resets eligible Provider limits. The card cannot be restored
							after use.
							{selectedCredit?.expiresAt ? ` It expires ${formatTime(selectedCredit.expiresAt)}.` : ""}
						</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<button
							className="min-h-7 rounded-xs bg-button-secondary-background px-3 text-sm text-button-secondary-foreground hover:bg-button-secondary-background-hover disabled:opacity-50"
							disabled={resetting}
							onClick={() => setSelectedCreditId(undefined)}
							type="button">
							Cancel
						</button>
						<button
							className="min-h-7 rounded-xs border border-error/70 bg-error/15 px-3 text-sm font-medium text-error hover:bg-error/25 disabled:opacity-50"
							disabled={resetting}
							onClick={() => void consumeReset()}
							type="button">
							{resetting ? "Resetting…" : "Use reset card"}
						</button>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
