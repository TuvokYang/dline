import type { ApiCostSegment } from "@shared/getApiMetrics"
import { useState } from "react"
import { formatCurrencyAmount } from "@/utils/currency"
import { formatTokenMetric } from "../util"
import { TaskRateMetricsDialog } from "./TaskRateMetricsDialog"

/**
 * Pick the amount the capsule shows.
 *
 * A task's cost is recorded per billing currency, and the newest segment is the one worth showing.
 * A subscription reports its amount without a currency, so that segment cannot be labelled; the
 * newest segment that does carry a currency is shown instead, which keeps the last priced run on
 * screen rather than replacing it with a bare number.
 */
function resolveDisplayedCost(
    segments: ApiCostSegment[] | undefined,
    totalCost: number,
    currency: string | undefined,
): { totalCost: number; currency: string | undefined } {
    if (segments) {
        for (let index = segments.length - 1; index >= 0; index -= 1) {
            const segment = segments[index]
            if (segment.currency) return { totalCost: segment.totalCost, currency: segment.currency }
        }
    }
    return { totalCost, currency }
}

interface TaskRateMetricsProps {
    taskId?: string
    taskInstanceId?: string
    requestsPerMinute: number
    tokensPerMinute: number
    totalInputTokens: number
    tokensOut: number
    cacheReads?: number
    cacheWrites?: number
    cacheHitRate?: number
    totalCost: number
    currency?: string
    /** Per-currency cost runs, newest last. The capsule shows the newest labelled one. */
    costSegments?: ApiCostSegment[]
    isCostAvailable: boolean
}

/** Display the unified task metrics capsule and open its history view. */
export function TaskRateMetrics({
    cacheHitRate,
    cacheReads,
    cacheWrites,
    currency,
    isCostAvailable,
    taskId,
    taskInstanceId,
    tokensOut,
    totalCost,
    totalInputTokens,
    costSegments,
    requestsPerMinute,
    tokensPerMinute,
}: TaskRateMetricsProps) {
    const [open, setOpen] = useState(false)
    const hasTokenUsage = totalInputTokens > 0 || tokensOut > 0
    const hasRateUsage = requestsPerMinute > 0 || tokensPerMinute > 0
    const usageTitle = `In: ${totalInputTokens} / Out: ${tokensOut} / Cache read: ${cacheReads ?? 0} / Cache write: ${cacheWrites ?? 0}`
    const displayedCost = resolveDisplayedCost(costSegments, totalCost, currency)
    const costLabel = formatCurrencyAmount(displayedCost.totalCost, displayedCost.currency, 3)
    const accessibleLabel = [
        "View API rate history",
        `In: ${totalInputTokens}`,
        `Out: ${tokensOut}`,
        `RPM: ${requestsPerMinute}`,
        `TPM: ${tokensPerMinute}`,
        `Cache read: ${cacheReads ?? 0}`,
        `Cache write: ${cacheWrites ?? 0}`,
        cacheHitRate != null ? `Hit: ${cacheHitRate.toFixed(1)}%` : undefined,
        isCostAvailable ? `Cost: ${costLabel}` : undefined,
    ]
        .filter((value): value is string => value !== undefined)
        .join("; ")
    const secondaryClassName = `inline-flex items-center gap-1.5 task-metrics-secondary${hasTokenUsage ? " @max-sm:hidden" : ""}`

    return (
        <>
            <button
                aria-label={accessibleLabel}
                className="ml-auto mr-1 inline-flex max-w-full min-w-0 items-center justify-end gap-1.5 whitespace-nowrap rounded-full border-0 bg-success/80 px-1.5 py-0.25 text-xs font-medium text-background hover:bg-success focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                data-testid="task-rate-metrics"
                id="price-tag"
                onClick={(event) => {
                    event.stopPropagation()
                    setOpen(true)
                }}
                onKeyDown={(event) => event.stopPropagation()}
                title={usageTitle}
                type="button">
                <span className="inline-flex items-center gap-1.5 task-metrics-primary">
                    {totalInputTokens > 0 && <span data-testid="task-metrics-in">In:{formatTokenMetric(totalInputTokens)}</span>}
                    {tokensOut > 0 && <span data-testid="task-metrics-out">Out:{formatTokenMetric(tokensOut)}</span>}
                </span>
                <span className={secondaryClassName} data-testid="task-metrics-secondary">
                    {hasRateUsage && (
                        <>
                            <span>RPM:{formatTokenMetric(requestsPerMinute)}</span>
                            <span>TPM:{formatTokenMetric(tokensPerMinute)}</span>
                        </>
                    )}
                    {cacheHitRate != null && <span>Hit:{cacheHitRate.toFixed(1)}%</span>}
                    {isCostAvailable && <span>{costLabel}</span>}
                </span>
            </button>
            <TaskRateMetricsDialog onOpenChange={setOpen} open={open} taskId={taskId} taskInstanceId={taskInstanceId} />
        </>
    )
}
