import { calculateApiUsageStatistics } from "@shared/api-usage"
import { formatCurrencyAmount } from "@/utils/currency"
import { formatTokenMetric } from "../task-header/util"

interface SubagentMetricsProps {
    toolCalls: number | undefined
    startedAt: number | undefined
    finishedAt: number | undefined
    /** Uncached input tokens, as normalized provider usage reports them. */
    inputTokens: number | undefined
    outputTokens: number | undefined
    cacheWriteTokens?: number
    cacheReadTokens?: number
    cacheHitRate?: number
    contextTokens?: number
    contextWindow?: number
    totalCost: number | undefined
    currency: string | undefined
    className?: string
}

function normalizeCount(value: number | undefined): number {
    return Number.isFinite(value) ? Math.max(0, Math.round(value ?? 0)) : 0
}

/**
 * Context usage against the model's window.
 *
 * Returns undefined when the window is unknown or non-positive: a percentage of
 * an unknown denominator would mislead, so the segment is omitted rather than
 * rendered as zero.
 */
function formatContextUsage(contextTokens: number | undefined, contextWindow: number | undefined): string | undefined {
    if (!Number.isFinite(contextWindow) || (contextWindow ?? 0) <= 0) return undefined
    if (!Number.isFinite(contextTokens)) return undefined

    const window = contextWindow as number
    const used = Math.max(0, Math.round(contextTokens as number))
    const percentage = Math.min(100, Math.round((used / window) * 100))
    return `Ctx:${formatTokenMetric(used)}/${formatTokenMetric(window)} (${percentage}%)`
}

export function formatSubagentDuration(startedAt: number | undefined, finishedAt: number | undefined): string {
    if (!Number.isFinite(startedAt)) return "0s"

    const normalizedStart = startedAt as number
    const normalizedEnd = Number.isFinite(finishedAt) ? (finishedAt as number) : Date.now()
    const seconds = Math.max(0, Math.floor((normalizedEnd - normalizedStart) / 1000))
    const minutes = Math.floor(seconds / 60)
    return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`
}

function formatSubagentCost(totalCost: number | undefined, currency: string | undefined): string {
    const normalizedCost = Number.isFinite(totalCost) ? Math.max(0, totalCost ?? 0) : 0
    const maximumFractionDigits = normalizedCost >= 0.01 ? 2 : 4
    return formatCurrencyAmount(normalizedCost, currency, maximumFractionDigits)
}

export function SubagentMetrics({
    toolCalls,
    startedAt,
    finishedAt,
    inputTokens,
    outputTokens,
    cacheWriteTokens,
    cacheReadTokens,
    cacheHitRate,
    contextTokens,
    contextWindow,
    totalCost,
    currency,
    className,
}: SubagentMetricsProps) {
    const normalizedToolCalls = normalizeCount(toolCalls)
    // Normalized usage reports cached input separately, so "In" must add the
    // cache terms back; otherwise a well-cached run shows only the uncached tail.
    // This matches the main task header and the cache hit-rate denominator.
    const normalizedInputTokens = normalizeCount(
        calculateApiUsageStatistics({
            inputTokens: normalizeCount(inputTokens),
            outputTokens: 0,
            cacheWriteTokens: normalizeCount(cacheWriteTokens),
            cacheReadTokens: normalizeCount(cacheReadTokens),
        }).totalInputTokens,
    )
    const normalizedOutputTokens = normalizeCount(outputTokens)
    const normalizedCacheHitRate = Number.isFinite(cacheHitRate) ? Math.max(0, Math.min(100, cacheHitRate ?? 0)) : undefined
    const contextUsage = formatContextUsage(contextTokens, contextWindow)
    const classes = [
        "inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[10px] text-description tabular-nums",
        className,
    ]
        .filter(Boolean)
        .join(" ")

    return (
        <span className={classes} data-testid="subagent-metrics">
            <span>{`${normalizedToolCalls} ${normalizedToolCalls === 1 ? "tool" : "tools"}`}</span>
            <span aria-hidden="true">·</span>
            <span>{formatSubagentDuration(startedAt, finishedAt)}</span>
            <span aria-hidden="true">·</span>
            <span>{`In:${formatTokenMetric(normalizedInputTokens)}`}</span>
            <span>{`Out:${formatTokenMetric(normalizedOutputTokens)}`}</span>
            {normalizedCacheHitRate !== undefined && (
                <span>{`Cache:${normalizedCacheHitRate.toFixed(2).replace(/\.00$/, "")}%`}</span>
            )}
            {contextUsage !== undefined && (
                <>
                    <span aria-hidden="true">·</span>
                    <span data-testid="subagent-context-usage">{contextUsage}</span>
                </>
            )}
            <span aria-hidden="true">·</span>
            <span>{formatSubagentCost(totalCost, currency)}</span>
        </span>
    )
}
