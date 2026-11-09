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
import type { UiTranslator } from "@/i18n/messages"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { formatCurrencyAmount } from "@/utils/currency"
import { formatTokenMetric } from "@/utils/format"

export type ProviderUsageProgressTone = "success" | "warning" | "caution" | "danger"

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

/**
 * Describe when a usage snapshot was read.
 *
 * The snapshot is held until the user refreshes it, so every surface showing
 * the numbers also states their age; otherwise an hours-old reading looks
 * current. Relative wording is used because the exact clock time matters less
 * than whether the reading is stale.
 */
export function formatUsageRetrievedAt(
    retrievedAt: string | undefined,
    t: UiTranslator,
    now: number = Date.now(),
): string | undefined {
    if (!retrievedAt) return undefined
    const readingTime = Date.parse(retrievedAt)
    if (!Number.isFinite(readingTime)) return undefined
    const elapsedMinutes = Math.floor((now - readingTime) / 60_000)
    if (elapsedMinutes < 1) return t("settings.ui.usage.updatedNow")
    if (elapsedMinutes < 60) return t("settings.ui.usage.updatedMinutes", { count: elapsedMinutes })
    const elapsedHours = Math.floor(elapsedMinutes / 60)
    if (elapsedHours < 24) return t("settings.ui.usage.updatedHours", { count: elapsedHours })
    return t("settings.ui.usage.updatedDays", { count: Math.floor(elapsedHours / 24) })
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

/**
 * The local day total a reader should show, or `undefined` when there is none.
 *
 * `Today In` is fresh input plus the cache traffic the provider reported, because
 * cache reads and writes are inputs the account paid for and are never part of the
 * fresh count. The inclusive legacy day total is added only when it is present and
 * still marked as a baseline contribution.
 */
export function localTodayInput(usage: AccountUsageData): number | undefined {
    const local = usage.local
    if (!local) return undefined
    // A snapshot that reported no usage at all says nothing about today: showing 0
    // would claim a quiet day rather than an unmeasured one.
    if (!local.usageReported && local.legacyInputTokens === undefined) return undefined
    // `inputTokens` is fresh input only: the cache segments are input the account also
    // paid for, reported apart from it. Omitting them made the day total understate
    // usage on exactly the providers that cache aggressively.
    return local.inputTokens + (local.cacheWriteTokens ?? 0) + (local.cacheReadTokens ?? 0) + (local.legacyInputTokens ?? 0)
}

/** The local day's output, or `undefined` when the source reported nothing. */
export function localTodayOutput(usage: AccountUsageData): number | undefined {
    const local = usage.local
    if (!local) return undefined
    if (!local.usageReported && local.outputTokens === 0 && local.legacyInputTokens === undefined) return undefined
    return local.outputTokens
}

/**
 * The cache hit rate, or `undefined` when the provider reported no hit/miss split.
 *
 * A provider that does not report cache hits has no rate; rendering 0% would state
 * that every cached token missed, which is a different claim from "not reported".
 */
export function localCacheHitRate(usage: AccountUsageData): number | undefined {
    const local = usage.local
    if (!local) return undefined
    const hit = local.cacheHitTokens
    const miss = local.cacheMissTokens
    if (hit === undefined || miss === undefined) return undefined
    const total = hit + miss
    if (total <= 0) return undefined
    return (hit / total) * 100
}

type LocalUsageNote = { kind: "legacy" | "degraded"; message: string }

/**
 * Say what a reader has to know about a local snapshot before trusting it.
 *
 * Degradation and an inclusive legacy contribution are both stated, because either
 * one makes the number smaller or larger than a fresh, complete read would be.
 */
export function localUsageNotes(usage: AccountUsageData, t: UiTranslator): LocalUsageNote[] {
    const local = usage.local
    if (!local) return []
    const notes: LocalUsageNote[] = []
    if (local.legacyInputTokens !== undefined) {
        notes.push({
            kind: "legacy",
            message: local.legacyPartial ? t("settings.ui.usage.legacyPartial") : t("settings.ui.usage.legacy"),
        })
    }
    if (local.degraded) notes.push({ kind: "degraded", message: t("settings.ui.usage.degraded") })
    return notes
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
    const { t } = useUiTranslation()
    const remainingPercent = usageRemainingPercent(quota)
    const tone = providerUsageProgressTone(remainingPercent)
    return (
        <div
            aria-label={t("settings.ui.usage.progress", { label: quota.label })}
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

function resetResultMessage(outcome: string, quotaTypesReset: readonly string[], t: UiTranslator): string {
    switch (outcome) {
        case "reset":
            return quotaTypesReset.length > 0
                ? t("settings.ui.usage.resetCompleted", { quotas: quotaTypesReset })
                : t("settings.ui.usage.resetEligible")
        case "nothing_to_reset":
            return t("settings.ui.usage.nothingToReset")
        case "no_credit":
            return t("settings.ui.usage.noCredit")
        case "already_redeemed":
            return t("settings.ui.usage.alreadyRedeemed")
        default:
            return t("settings.ui.usage.unknownReset")
    }
}

/**
 * Today's tokens, preferring this installation's committed facts.
 *
 * Two sources can describe the same day: the provider's own day counters and the
 * facts this installation committed. The committed record is preferred because it
 * carries the degradation and legacy notes a reader needs; the provider counters
 * remain the fallback so a snapshot read before any local fact existed still shows
 * a day total. A source that reported nothing renders nothing rather than zero.
 */
function LocalDailyUsage({ usage }: { usage: AccountUsageData }) {
    const { t } = useUiTranslation()
    const localInput = localTodayInput(usage)
    const localOutput = localTodayOutput(usage)
    const localHitRate = localCacheHitRate(usage)
    const notes = localUsageNotes(usage, t)

    if (localInput === undefined || localOutput === undefined) {
        return usage.dailyInputTokens !== undefined || usage.dailyOutputTokens !== undefined ? (
            // Each metric stays on one line; a narrow tooltip moves the whole
            // second metric down instead of splitting a label from its value.
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-description">
                <span className="whitespace-nowrap">
                    {t("settings.ui.usage.todayInput", { count: formatTokenMetric(usage.dailyInputTokens ?? 0) })}
                </span>
                <span className="whitespace-nowrap">
                    {t("settings.ui.usage.todayOutput", { count: formatTokenMetric(usage.dailyOutputTokens ?? 0) })}
                </span>
            </div>
        ) : null
    }

    return (
        <div className="flex flex-col gap-1 text-description">
            <div className="flex flex-wrap gap-x-4 gap-y-1">
                <span className="whitespace-nowrap">
                    {t("settings.ui.usage.todayInput", { count: formatTokenMetric(localInput) })}
                </span>
                <span className="whitespace-nowrap">
                    {t("settings.ui.usage.todayOutput", { count: formatTokenMetric(localOutput) })}
                </span>
                {localHitRate === undefined ? null : (
                    <span className="whitespace-nowrap">
                        {t("settings.ui.usage.cacheHit", { percent: localHitRate.toFixed(0) })}
                    </span>
                )}
            </div>
            {notes.map((note) => (
                <span className="text-[10px] text-description" key={note.kind}>
                    {note.message}
                </span>
            ))}
        </div>
    )
}

export interface ProviderUsageDetailsProps {
    readonly usage: AccountUsageData
    readonly resetting: boolean
    readonly resetError?: string
    readonly showResetActions?: boolean
    /**
     * Show the snapshot age above the details. The settings card already shows
     * it on its header row, so it opts out rather than repeating the line.
     */
    readonly showRetrievedAt?: boolean
    readonly resetCreditsDisplay?: "full" | "summary"
    readonly consumeResetCredit: (creditId: string) => Promise<AccountUsageResetResult | undefined>
}

/** Provider-neutral quota, progress, and reset-credit renderer. */
export function ProviderUsageDetails({
    usage,
    resetting,
    resetError,
    showResetActions = true,
    showRetrievedAt = true,
    resetCreditsDisplay = "full",
    consumeResetCredit,
}: ProviderUsageDetailsProps) {
    const { t } = useUiTranslation()
    const [selectedCreditId, setSelectedCreditId] = useState<string>()
    const [resultMessage, setResultMessage] = useState<{ outcome: string; quotaTypesReset: string[] }>()
    const resetCredits = usage.resetCredits ?? []
    const nextResetCredit = resetCredits[0]
    const selectedCredit = resetCredits.find((credit) => credit.id === selectedCreditId)
    const supportsResetCredits = usage.resetCredits !== undefined || usage.resetCreditsAvailableCount !== undefined

    const consumeReset = async () => {
        if (!selectedCreditId) return
        const result = await consumeResetCredit(selectedCreditId)
        if (!result) return
        setResultMessage({ outcome: result.outcome, quotaTypesReset: result.quotaTypesReset })
        setSelectedCreditId(undefined)
    }

    // Shown by both the chat tooltip and the expanded menu, because the reading
    // is only as current as the last refresh in either surface.
    const retrievedAt = showRetrievedAt ? formatUsageRetrievedAt(usage.retrievedAt, t) : undefined

    return (
        <>
            <div className="flex flex-col gap-2 text-xs">
                {retrievedAt ? <span className="text-[10px] text-description">{retrievedAt}</span> : null}
                {usage.planType ? (
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-description">{t("settings.ui.opencode.plan")}</span>
                        <span className="font-medium text-foreground">{usage.planType}</span>
                    </div>
                ) : null}
                {!usage.planType && usage.remainingBalance !== undefined ? (
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-description">{t("settings.ui.usage.balance")}</span>
                        <span className="font-medium text-foreground">
                            {formatCurrencyAmount(usage.remainingBalance, usage.currency)}
                        </span>
                    </div>
                ) : null}
                <LocalDailyUsage usage={usage} />
                {/* Filtered like the chat bar: an unusable reading rendered as
				    "0% remaining" would claim the window is exhausted. */}
                {usage.quotas?.filter(isReadableUsageQuota).map((quota, index) => {
                    const resetAt = formatTime(quota.resetAt)
                    return (
                        // Two scoped caps may share a display name, so position disambiguates.
                        <div className="flex flex-col gap-1" key={`${quota.type}:${quota.label}:${index}`}>
                            <div className="flex items-center justify-between gap-2">
                                <span>{quota.label}</span>
                                <span className="font-medium text-foreground">
                                    {t("settings.ui.usage.remaining", { percent: usageRemainingPercent(quota).toFixed(0) })}
                                </span>
                            </div>
                            <ProviderUsageProgressBar quota={quota} />
                            {resetAt ? (
                                <span className="whitespace-nowrap text-description">
                                    {t("settings.ui.usage.resets", { time: resetAt })}
                                </span>
                            ) : null}
                        </div>
                    )
                })}
                {supportsResetCredits ? (
                    <div className="mt-1 flex flex-col gap-1.5 border-t border-editor-widget-border/50 pt-2">
                        <span className="font-medium text-foreground">
                            {t("settings.ui.usage.cards", { count: usage.resetCreditsAvailableCount ?? 0 })}
                        </span>
                        {resetCredits.length > 0 && resetCreditsDisplay === "summary" ? (
                            <div className="flex flex-col gap-0.5 text-description">
                                <span>{t("settings.ui.usage.nextExpiry")}</span>
                                <span className="whitespace-nowrap">
                                    {nextResetCredit?.expiresAt
                                        ? formatTime(nextResetCredit.expiresAt)
                                        : t("settings.ui.usage.expiryUnavailable")}
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
                                                <span className="block font-medium text-foreground">
                                                    {t("settings.ui.usage.card", { index: index + 1 })}
                                                </span>
                                                <span className="block whitespace-nowrap text-description">
                                                    {expiresAt
                                                        ? t("settings.ui.usage.expires", { time: expiresAt })
                                                        : t("settings.ui.usage.expiryUnavailable")}
                                                </span>
                                            </div>
                                            {showResetActions ? (
                                                <button
                                                    aria-label={t("settings.ui.usage.useCardIndex", { index: index + 1 })}
                                                    className="inline-flex min-h-7 shrink-0 items-center rounded-xs border border-error/70 bg-error/15 px-2 font-medium text-error hover:bg-error/25 disabled:opacity-50"
                                                    disabled={resetting}
                                                    onClick={() => {
                                                        setResultMessage(undefined)
                                                        setSelectedCreditId(credit.id)
                                                    }}
                                                    type="button">
                                                    {t("settings.ui.usage.useCard")}
                                                </button>
                                            ) : null}
                                        </li>
                                    )
                                })}
                            </ul>
                        ) : (
                            <span className="text-description">{t("settings.ui.usage.noCards")}</span>
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
                        {resetResultMessage(resultMessage.outcome, resultMessage.quotaTypesReset, t)}
                    </div>
                ) : null}
            </div>
            <AlertDialog
                onOpenChange={(open) => !open && !resetting && setSelectedCreditId(undefined)}
                open={selectedCreditId !== undefined}>
                <AlertDialogContent aria-label={t("settings.ui.usage.confirmTitle")}>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            <TriangleAlertIcon className="size-5 text-editor-warning-foreground" />
                            {t("settings.ui.usage.confirmTitle")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {t("settings.ui.usage.confirmHelp", {
                                expiry: selectedCredit?.expiresAt ? (formatTime(selectedCredit.expiresAt) ?? "") : "",
                            })}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <button
                            className="min-h-7 rounded-xs bg-button-secondary-background px-3 text-sm text-button-secondary-foreground hover:bg-button-secondary-background-hover disabled:opacity-50"
                            disabled={resetting}
                            onClick={() => setSelectedCreditId(undefined)}
                            type="button">
                            {t("settings.ui.cancel")}
                        </button>
                        <button
                            className="min-h-7 rounded-xs border border-error/70 bg-error/15 px-3 text-sm font-medium text-error hover:bg-error/25 disabled:opacity-50"
                            disabled={resetting}
                            onClick={() => void consumeReset()}
                            type="button">
                            {resetting ? t("settings.ui.usage.resetting") : t("settings.ui.usage.useResetCard")}
                        </button>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    )
}
