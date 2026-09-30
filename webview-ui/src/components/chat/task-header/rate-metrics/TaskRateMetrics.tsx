import { useState } from "react"
import { formatTokenMetric } from "../util"
import { TaskRateMetricsDialog } from "./TaskRateMetricsDialog"

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
	requestsPerMinute,
	tokensPerMinute,
}: TaskRateMetricsProps) {
	const [open, setOpen] = useState(false)
	const displayCurrency = (currency || "USD").toUpperCase()
	const hasTokenUsage = totalInputTokens > 0 || tokensOut > 0
	const hasRateUsage = requestsPerMinute > 0 || tokensPerMinute > 0
	const usageTitle = `In: ${totalInputTokens} / Out: ${tokensOut} / Cache read: ${cacheReads ?? 0} / Cache write: ${cacheWrites ?? 0}`
	const costLabel = `${{ USD: "$", CNY: "¥", EUR: "€", GBP: "£" }[displayCurrency] || "$"}${totalCost.toFixed(3)}`
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
