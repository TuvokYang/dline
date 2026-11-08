import type { PricingTimeWindow } from "@shared/proto/dline/models/metadata"
import { readTimeWindowRate, withTimeWindowRateKind } from "@shared/providers/pricing-shape"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useId, useRef, useState } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ProfileField, ProfileInlineGrid, ProfileSectionTitle } from "../profile-ui"
import { flushPendingDebouncedInputs } from "../utils/useDebouncedInput"
import { DebouncedTextField } from "./DebouncedTextField"
import { PricingTierEditor } from "./ModelTierEditor"
import { PriceSetFields } from "./PriceSetFields"
import { formatPricingClock as formatClock, PricingTimeline } from "./PricingTimeline"

interface TimeWindowEditorProps {
    windows: readonly PricingTimeWindow[]
    currencySymbol: string
    showCachePrices: boolean
    editable: boolean
    heading?: string
    peakOffPeakLabels?: boolean
    ratesEditable?: boolean
    timezoneOffsetMinutes: number
    defaultRate?: Pick<PricingTimeWindow, "prices" | "bands">
    onChange?: (windows: PricingTimeWindow[]) => void
}

function parseClock(text: string): number | undefined {
    const match = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
    if (!match) return undefined
    const hours = Number(match[1])
    const minutes = Number(match[2])
    return hours <= 24 && minutes < 60 && (hours < 24 || minutes === 0) ? hours * 60 + minutes : undefined
}

function ClockField({
    label,
    accessibleLabel = label,
    value,
    onChange,
}: {
    label: string
    accessibleLabel?: string
    value: number
    onChange: (value: number) => boolean
}) {
    const id = useId()
    const [invalid, setInvalid] = useState(false)
    return (
        <ProfileField htmlFor={id} label={label}>
            <DebouncedTextField
                ariaLabel={accessibleLabel}
                id={id}
                initialValue={formatClock(value)}
                onChange={(text) => {
                    const parsed = parseClock(text)
                    setInvalid(parsed === undefined || !onChange(parsed))
                }}
            />
            {invalid && (
                <span className="text-xs text-error" role="alert">
                    Use HH:MM between 00:00 and 24:00, with start before end and no overlapping windows.
                </span>
            )}
        </ProfileField>
    )
}

/** Choose an available editor interval instead of appending an empty [1440,1440) window. */
function firstGap(windows: readonly PricingTimeWindow[]): { startMinute: number; endMinute: number } | undefined {
    let start = 0
    for (const window of [...windows].sort((a, b) => a.startMinute - b.startMinute)) {
        if (start < window.startMinute) return { startMinute: start, endMinute: Math.min(start + 60, window.startMinute) }
        start = Math.max(start, window.endMinute)
    }
    return start < 1440 ? { startMinute: start, endMinute: Math.min(start + 60, 1440) } : undefined
}

/** Render every declared window and its complete prices or token bands. */
export const TimeWindowEditor = ({
    windows,
    currencySymbol,
    showCachePrices,
    editable,
    heading = "Time Windows",
    peakOffPeakLabels = false,
    ratesEditable = editable,
    timezoneOffsetMinutes,
    defaultRate,
    onChange,
}: TimeWindowEditorProps) => {
    const id = useId()
    const [flushFailed, setFlushFailed] = useState(false)
    const afterInputFlush = (change: () => void) => {
        void flushPendingDebouncedInputs()
            .then(() => {
                setFlushFailed(false)
                change()
            })
            .catch(() => setFlushFailed(true))
    }
    const latest = useRef(windows)
    useEffect(() => {
        latest.current = windows
    }, [windows])
    const gap = firstGap(windows)
    const offset = `${timezoneOffsetMinutes < 0 ? "-" : "+"}${formatClock(Math.abs(timezoneOffsetMinutes))}`
    const windowScope = (window: PricingTimeWindow, index: number) =>
        peakOffPeakLabels
            ? `Peak window ${formatClock(window.startMinute)} – ${formatClock(window.endMinute)}`
            : `Window ${index + 1}`
    const chartLabel = peakOffPeakLabels
        ? "Configured peak pricing windows in seller time"
        : "Configured pricing windows in seller time"
    const publish = (next: PricingTimeWindow[]) => {
        latest.current = next
        onChange?.(next)
    }
    const replace = (index: number, updates: Partial<PricingTimeWindow>): boolean => {
        const next = { ...latest.current[index], ...updates }
        if (
            next.startMinute >= next.endMinute ||
            latest.current.some(
                (other, at) => at !== index && next.startMinute < other.endMinute && other.startMinute < next.endMinute,
            )
        )
            return false
        publish(latest.current.map((window, at) => (at === index ? next : window)))
        return true
    }
    const addWindow = () => {
        const available = firstGap(latest.current)
        if (!available) return
        const rate = defaultRate ?? { prices: latest.current.at(-1)?.prices ?? {} }
        publish([...latest.current, { ...available, ...rate }])
    }
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
                <ProfileSectionTitle className="text-xs uppercase tracking-wide text-description">{heading}</ProfileSectionTitle>
                {editable && (
                    <VSCodeButton disabled={!gap} onClick={() => afterInputFlush(addWindow)}>
                        Add Time Window
                    </VSCodeButton>
                )}
            </div>
            {flushFailed && (
                <span className="text-xs text-error" role="alert">
                    Pending inputs could not be saved. Retry before changing windows.
                </span>
            )}
            <span className="text-xs text-description">Seller time: UTC{offset}</span>
            <PricingTimeline label={chartLabel} peakOffPeakLabels={peakOffPeakLabels} windows={windows} />
            {windows.map((window, index) => (
                <div className="flex flex-col gap-2 rounded-xs border border-editor-widget-border p-2" key={`${id}-${index}`}>
                    <strong className="text-xs">
                        {peakOffPeakLabels ? "Peak window" : `Window ${index + 1}`} · {formatClock(window.startMinute)} –{" "}
                        {formatClock(window.endMinute)}
                    </strong>
                    {editable && (
                        <ProfileInlineGrid>
                            <ClockField
                                accessibleLabel={`${windowScope(window, index)} Start (HH:MM, UTC${offset})`}
                                label={`Start (HH:MM, UTC${offset})`}
                                onChange={(startMinute) => replace(index, { startMinute })}
                                value={window.startMinute}
                            />
                            <ClockField
                                accessibleLabel={`${windowScope(window, index)} End (HH:MM, UTC${offset})`}
                                label={`End (HH:MM, UTC${offset})`}
                                onChange={(endMinute) => replace(index, { endMinute })}
                                value={window.endMinute}
                            />
                            <ProfileField htmlFor={`${id}-${index}-kind`} label="Rate">
                                <Select
                                    onValueChange={(kind) =>
                                        afterInputFlush(() =>
                                            publish(withTimeWindowRateKind(latest.current, index, kind as "prices" | "bands")),
                                        )
                                    }
                                    value={readTimeWindowRate(window)}>
                                    <SelectTrigger id={`${id}-${index}-kind`}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="prices">Single rate</SelectItem>
                                        <SelectItem value="bands">By context size</SelectItem>
                                    </SelectContent>
                                </Select>
                            </ProfileField>
                        </ProfileInlineGrid>
                    )}
                    {window.bands ? (
                        <PricingTierEditor
                            currencySymbol={currencySymbol}
                            editable={editable}
                            onChange={(bands) => replace(index, { prices: undefined, bands: { bands } })}
                            ratesEditable={ratesEditable}
                            showCachePrices={showCachePrices}
                            tiers={window.bands.bands}
                        />
                    ) : (
                        <PriceSetFields
                            accessiblePrefix={windowScope(window, index)}
                            currencySymbol={currencySymbol}
                            onChange={(prices) => replace(index, { prices, bands: undefined })}
                            prices={window.prices}
                            readOnly={!ratesEditable}
                            showCachePrices={showCachePrices}
                        />
                    )}
                    {editable && (
                        <VSCodeButton
                            appearance="secondary"
                            onClick={() => afterInputFlush(() => publish(latest.current.filter((_, at) => at !== index)))}>
                            Remove Time Window
                        </VSCodeButton>
                    )}
                </div>
            ))}
        </div>
    )
}
