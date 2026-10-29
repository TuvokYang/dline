import React, { useId, useState } from "react"
import { type ContextWindowIndicatorViewModel, DURABLE_PART_COLORS } from "./ContextWindowIndicatorViewModel"

interface TokenUsageInfoProps {
    tokensIn?: number
    tokensOut?: number
    cacheWrites?: number
    cacheReads?: number
}

interface TaskContextWindowButtonsProps extends TokenUsageInfoProps {
    percentage: number
    tokenUsed: number
    contextWindow: number
    autoCompactThreshold?: number
    isThresholdChanged?: boolean
    isThresholdFadingOut?: boolean
    indicatorViewModel?: ContextWindowIndicatorViewModel
    /** Controls the durable breakdown; omitted, the summary keeps its own expansion state. */
    durableExpanded?: boolean
    onDurableExpandedChange?: (expanded: boolean) => void
}

const SEGMENT_COLORS = {
    durable: "var(--vscode-charts-green, #3fb950)",
    active: "var(--vscode-charts-blue, #58a6ff)",
    staged: "var(--vscode-charts-orange, #d18616)",
    environment: "var(--vscode-charts-purple, #bc8cff)",
} as const

const TOKEN_NUMBER_UNITS = [
    { divisor: 1e15, suffix: "Q" },
    { divisor: 1e12, suffix: "T" },
    { divisor: 1e9, suffix: "B" },
    { divisor: 1e6, suffix: "M" },
    { divisor: 1e3, suffix: "k" },
] as const

function formatSummaryTokenNumber(tokens: number): string {
    const normalizedTokens = Number.isFinite(tokens) ? Math.max(0, Math.round(tokens)) : 0
    const initialUnitIndex = TOKEN_NUMBER_UNITS.findIndex((unit) => normalizedTokens >= unit.divisor)
    if (initialUnitIndex < 0) return normalizedTokens.toString()

    for (let unitIndex = initialUnitIndex; unitIndex >= 0; unitIndex -= 1) {
        const unit = TOKEN_NUMBER_UNITS[unitIndex]
        if (!unit) continue
        const scaledTokens = normalizedTokens / unit.divisor
        const integerDigits = Math.max(1, Math.floor(scaledTokens).toString().length)
        const maximumDecimals = Math.max(0, 6 - unit.suffix.length - integerDigits - 1)
        const decimals = unitIndex === initialUnitIndex ? Math.min(1, maximumDecimals) : maximumDecimals
        const formattedValue = `${scaledTokens.toFixed(decimals)}${unit.suffix}`
        if (formattedValue.length <= 6) return formattedValue
    }

    return normalizedTokens.toExponential(1).replace("e+", "e")
}

function getSegmentColor(segment: ContextWindowIndicatorViewModel["segments"][number]): string {
    if (segment.kind === "active" && segment.label === "Receiving") return "var(--vscode-charts-yellow, #d29922)"
    return SEGMENT_COLORS[segment.kind]
}

function DurableBreakdown({ id, viewModel }: { id: string; viewModel: ContextWindowIndicatorViewModel }) {
    const parts = viewModel.durableBreakdown
    return (
        <div
            className="flex flex-col gap-1 border-t border-foreground/10 pt-2 text-[11px]"
            data-testid="context-window-durable-breakdown"
            id={id}>
            {parts ? (
                parts.map((part) => (
                    <div
                        className="grid grid-cols-[0.6rem_1fr_6ch_4ch] items-center gap-1.5"
                        data-durable-breakdown-part={part.part}
                        key={part.part}>
                        <span
                            aria-hidden="true"
                            className="h-2 w-2 rounded-sm"
                            style={{ backgroundColor: DURABLE_PART_COLORS[part.part] }}
                        />
                        <span className="truncate">{part.label}</span>
                        <span className="text-right font-mono">{formatSummaryTokenNumber(part.tokens)}</span>
                        <span className="text-right font-mono text-muted-foreground">{Math.round(part.percentOfDurable)}%</span>
                    </div>
                ))
            ) : (
                <div className="text-muted-foreground">Breakdown unavailable until the next request is measured.</div>
            )}
        </div>
    )
}

export const ContextWindowSummary: React.FC<TaskContextWindowButtonsProps> = ({
    contextWindow,
    tokenUsed,
    percentage,
    indicatorViewModel,
    durableExpanded,
    onDurableExpandedChange,
}) => {
    const [ownExpanded, setOwnExpanded] = useState(false)
    const breakdownId = useId()
    const expanded = durableExpanded ?? ownExpanded
    const toggleDurable = () => {
        const next = !expanded
        if (durableExpanded === undefined) setOwnExpanded(next)
        onDurableExpandedChange?.(next)
    }

    return (
        <div className="context-window-tooltip-content flex w-full flex-col gap-2" data-testid="context-window-summary">
            <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">Context Window</span>
                <span className="font-mono text-muted-foreground">{percentage.toFixed(1)}%</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs">
                <div
                    className="min-w-0 text-center"
                    data-context-summary-metric="used"
                    style={!indicatorViewModel ? { color: SEGMENT_COLORS.durable } : undefined}>
                    <div className="text-muted-foreground">Used</div>
                    <div className="font-mono">{formatSummaryTokenNumber(tokenUsed)}</div>
                </div>
                <div className="min-w-0 text-center" data-context-summary-metric="remaining">
                    <div className="text-muted-foreground">Remaining</div>
                    <div className="font-mono">
                        {formatSummaryTokenNumber(indicatorViewModel?.remainingTokens ?? Math.max(0, contextWindow - tokenUsed))}
                    </div>
                </div>
                <div className="min-w-0 text-center" data-context-summary-metric="total">
                    <div className="text-muted-foreground">Total</div>
                    <div className="font-mono">{formatSummaryTokenNumber(contextWindow)}</div>
                </div>
            </div>
            {!indicatorViewModel && (
                <div className="text-xs text-muted-foreground">Segment details unavailable for this saved task.</div>
            )}
            {indicatorViewModel && (
                <div
                    className="grid grid-cols-2 gap-1.5 border-t border-foreground/10 pt-2"
                    data-testid="context-window-segment-details">
                    {indicatorViewModel.segments.map((segment) => {
                        const className =
                            "grid grid-cols-[max-content_6ch] items-center justify-between gap-1 rounded px-2 py-1 text-[11px] text-white"
                        const content = (
                            <>
                                <span className="whitespace-nowrap font-semibold">{segment.label}</span>
                                <span className="w-[6ch] justify-self-end whitespace-nowrap text-right font-mono">
                                    {formatSummaryTokenNumber(segment.authoritativeTokens)}
                                </span>
                            </>
                        )
                        // Durable is the one card that opens a breakdown, so it alone is a button.
                        return segment.kind === "durable" ? (
                            <button
                                aria-controls={expanded ? breakdownId : undefined}
                                aria-expanded={expanded}
                                className={`${className} cursor-pointer border-0 text-left`}
                                data-segment-detail={segment.kind}
                                key={segment.kind}
                                onClick={toggleDurable}
                                style={{ backgroundColor: getSegmentColor(segment) }}
                                title="Show what the durable context is made of"
                                type="button">
                                {content}
                            </button>
                        ) : (
                            <div
                                className={className}
                                data-segment-detail={segment.kind}
                                key={segment.kind}
                                style={{ backgroundColor: getSegmentColor(segment) }}>
                                {content}
                            </div>
                        )
                    })}
                </div>
            )}
            {indicatorViewModel && expanded && <DurableBreakdown id={breakdownId} viewModel={indicatorViewModel} />}
        </div>
    )
}
