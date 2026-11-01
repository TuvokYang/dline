import type { ContextWindowBand, PriceSet, TimeWindow } from "@shared/proto/dline/models/metadata"
import { readPriceSet, readTimeWindowRate, withTimeWindowRateKind } from "@shared/providers/pricing-shape"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { useId } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ProfileActionRow, ProfileField, ProfileInlineGrid, ProfileSectionTitle } from "../profile-ui"
import { DebouncedTextField } from "./DebouncedTextField"
import { PricingTierEditor } from "./ModelTierEditor"

const fieldControlClass = "min-h-7 w-full"
const MINUTES_PER_DAY = 1440

interface TimeWindowEditorProps {
    windows: readonly TimeWindow[]
    currencySymbol: string
    showCachePrices: boolean
    editable: boolean
    /**
     * Seller offset the windows are read in, in minutes east of UTC.
     *
     * Windows are clock times in the seller's own zone, never the reader's, so
     * the editor states the offset instead of leaving the user to guess whether
     * 09:00 means their machine or the price list.
     */
    timezoneOffsetMinutes: number
    onChange: (windows: TimeWindow[]) => void
}

/**
 * Render a fixed UTC offset as `UTC+08:00`.
 *
 * The schedule carries an offset rather than a zone name, so this is the whole
 * truth about how a window is interpreted.
 */
function formatUtcOffset(offsetMinutes: number): string {
    const sign = offsetMinutes < 0 ? "-" : "+"
    const absolute = Math.abs(Math.round(offsetMinutes))
    const hours = String(Math.floor(absolute / 60)).padStart(2, "0")
    const minutes = String(absolute % 60).padStart(2, "0")
    return `UTC${sign}${hours}:${minutes}`
}

/**
 * Parse a clock entered as `HH:MM` into minutes from local midnight.
 *
 * The stored shape is minutes, but nobody reads a price list in minutes, so the
 * editor accepts the clock form a seller publishes. An unreadable entry keeps
 * the previous value rather than writing zero, which would move a window to
 * midnight without the user asking.
 */
function parseClockOfDay(value: string, fallback: number): number {
    const trimmed = value.trim()
    if (trimmed.length === 0) {
        return fallback
    }
    const match = /^(\d{1,2}):(\d{2})$/.exec(trimmed)
    if (!match) {
        const minutes = Number(trimmed)
        return Number.isFinite(minutes) && minutes >= 0 && minutes <= MINUTES_PER_DAY ? minutes : fallback
    }
    const hours = Number(match[1])
    const minutes = Number(match[2])
    if (hours > 24 || minutes > 59) {
        return fallback
    }
    return Math.min(hours * 60 + minutes, MINUTES_PER_DAY)
}

/** Render minutes from local midnight as `HH:MM`, including the end-of-day boundary. */
function formatClockOfDay(totalMinutes: number): string {
    const bounded = Math.min(Math.max(totalMinutes, 0), MINUTES_PER_DAY)
    const hours = Math.floor(bounded / 60)
    const minutes = bounded % 60
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`
}

/**
 * Move one boundary of a window without letting it collide with its neighbor.
 *
 * Windows never overlap, so a boundary grows only into the free gap next to it.
 * Clamping here keeps the list valid while the user types, instead of leaving
 * an overlap that billing would later reject.
 */
function withBounds(windows: readonly TimeWindow[], index: number, startMinute: number, endMinute: number): TimeWindow[] {
    const previousEnd = index > 0 ? windows[index - 1].endMinute : 0
    const nextStart = index < windows.length - 1 ? windows[index + 1].startMinute : MINUTES_PER_DAY
    const lowerBound = Math.max(previousEnd, 0)
    const upperBound = Math.min(nextStart, MINUTES_PER_DAY)
    const start = Math.min(Math.max(startMinute, lowerBound), upperBound)
    const end = Math.min(Math.max(endMinute, start), upperBound)
    return windows.map((window, windowIndex) =>
        windowIndex === index ? { ...window, startMinute: start, endMinute: end } : window,
    )
}

/** Read the four published rates of one window. */
function windowRates(window: TimeWindow): PriceSet | undefined {
    return window.prices ?? window.bands?.bands?.[0]?.prices
}

/**
 * Edit the windows of a time-of-day price.
 *
 * A window is a local-time interval with its own rate, which is what both a
 * single discount period and two daily peak periods are expressed with. Each
 * window bills either one price set or its own token bands, and the default rate
 * outside every window is edited separately by the caller.
 */
export const TimeWindowEditor = ({
    windows,
    currencySymbol,
    showCachePrices,
    editable,
    timezoneOffsetMinutes,
    onChange,
}: TimeWindowEditorProps) => {
    const baseId = useId()
    const utcOffset = formatUtcOffset(timezoneOffsetMinutes)

    /** Append a window after the last one, or a whole day when the list is empty. */
    const addWindow = () => {
        const lastEnd = windows.length > 0 ? windows[windows.length - 1].endMinute : 0
        const end = Math.min(lastEnd + 60, MINUTES_PER_DAY)
        onChange([...windows, { startMinute: lastEnd, endMinute: end, prices: { inputPrice: 0, outputPrice: 0 } }])
    }

    /** Remove one window by index. */
    const removeWindow = (index: number) => {
        onChange(windows.filter((_, windowIndex) => windowIndex !== index))
    }

    /** Replace one window wholesale, leaving its neighbours alone. */
    const replaceWindow = (index: number, next: TimeWindow) => {
        onChange(windows.map((window, windowIndex) => (windowIndex === index ? next : window)))
    }

    /** Change the rate shape of one window, carrying the rates across. */
    const changeRateKind = (index: number, kind: "prices" | "bands") => {
        onChange(withTimeWindowRateKind(windows, index, kind))
    }

    /** Replace one of the four base rates of a window. */
    const updatePrice = (index: number, slot: keyof Omit<PriceSet, "thinkingOutputPrice">, value: number) => {
        const window = windows[index]
        const rates = readPriceSet(windowRates(window))
        replaceWindow(index, {
            startMinute: window.startMinute,
            endMinute: window.endMinute,
            prices: { ...rates, [slot]: value },
        })
    }

    /** Replace the token bands of a window. */
    const updateBands = (index: number, bands: ContextWindowBand[]) => {
        const window = windows[index]
        replaceWindow(index, {
            startMinute: window.startMinute,
            endMinute: window.endMinute,
            bands: { bands },
        })
    }

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <ProfileSectionTitle className="text-xs uppercase tracking-wide text-description">
                    Time Windows
                </ProfileSectionTitle>
                {editable ? (
                    <ProfileActionRow>
                        <VSCodeButton onClick={addWindow}>Add Time Window</VSCodeButton>
                    </ProfileActionRow>
                ) : null}
            </div>
            <div className="text-xs text-description">
                {`Times are read as ${utcOffset}, the offset the price list publishes, not your machine's zone.`}
            </div>
            {windows.map((window, index) => {
                const rateKind = readTimeWindowRate(window)
                const rates = readPriceSet(windowRates(window))
                return (
                    <div
                        className={`flex min-w-0 flex-col gap-2 rounded-xs border border-editor-widget-border p-2 ${
                            index % 2 === 0 ? "bg-(--vscode-editor-background)" : "bg-(--vscode-sideBar-background)"
                        }`}
                        key={`window-${index}`}>
                        <div className="flex flex-col gap-1 text-sm">
                            <strong>{`${formatClockOfDay(window.startMinute)} – ${formatClockOfDay(window.endMinute)}`}</strong>
                        </div>
                        {editable ? (
                            <>
                                <ProfileInlineGrid>
                                    <ProfileField htmlFor={`${baseId}-${index}-start`} label={`Start (HH:MM, ${utcOffset})`}>
                                        <DebouncedTextField
                                            ariaLabel={`Window ${index + 1} Start (HH:MM, ${utcOffset})`}
                                            className={fieldControlClass}
                                            id={`${baseId}-${index}-start`}
                                            initialValue={formatClockOfDay(window.startMinute)}
                                            onChange={(value) =>
                                                onChange(
                                                    withBounds(
                                                        windows,
                                                        index,
                                                        parseClockOfDay(value, window.startMinute),
                                                        window.endMinute,
                                                    ),
                                                )
                                            }
                                        />
                                    </ProfileField>
                                    <ProfileField htmlFor={`${baseId}-${index}-end`} label={`End (HH:MM, ${utcOffset})`}>
                                        <DebouncedTextField
                                            ariaLabel={`Window ${index + 1} End (HH:MM, ${utcOffset})`}
                                            className={fieldControlClass}
                                            id={`${baseId}-${index}-end`}
                                            initialValue={formatClockOfDay(window.endMinute)}
                                            onChange={(value) =>
                                                onChange(
                                                    withBounds(
                                                        windows,
                                                        index,
                                                        window.startMinute,
                                                        parseClockOfDay(value, window.endMinute),
                                                    ),
                                                )
                                            }
                                        />
                                    </ProfileField>
                                    <ProfileField htmlFor={`${baseId}-${index}-rate`} label="Rate">
                                        <Select
                                            onValueChange={(value) => changeRateKind(index, value as "prices" | "bands")}
                                            value={rateKind}>
                                            <SelectTrigger
                                                aria-label={`Window ${index + 1} Rate`}
                                                className={fieldControlClass}
                                                id={`${baseId}-${index}-rate`}>
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="prices">Single rate</SelectItem>
                                                <SelectItem value="bands">By context size</SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </ProfileField>
                                </ProfileInlineGrid>
                                {rateKind === "prices" ? (
                                    <ProfileInlineGrid>
                                        <ProfileField
                                            htmlFor={`${baseId}-${index}-input`}
                                            label={`Window Input (${currencySymbol}/1M)`}>
                                            <DebouncedTextField
                                                ariaLabel={`Window ${index + 1} Input (${currencySymbol}/1M)`}
                                                className={fieldControlClass}
                                                id={`${baseId}-${index}-input`}
                                                initialValue={String(rates.inputPrice)}
                                                onChange={(value) => updatePrice(index, "inputPrice", parseClockPrice(value))}
                                            />
                                        </ProfileField>
                                        <ProfileField
                                            htmlFor={`${baseId}-${index}-output`}
                                            label={`Window Output (${currencySymbol}/1M)`}>
                                            <DebouncedTextField
                                                ariaLabel={`Window ${index + 1} Output (${currencySymbol}/1M)`}
                                                className={fieldControlClass}
                                                id={`${baseId}-${index}-output`}
                                                initialValue={String(rates.outputPrice)}
                                                onChange={(value) => updatePrice(index, "outputPrice", parseClockPrice(value))}
                                            />
                                        </ProfileField>
                                        {showCachePrices ? (
                                            <>
                                                <ProfileField
                                                    htmlFor={`${baseId}-${index}-cache-writes`}
                                                    label={`Window Cache Writes (${currencySymbol}/1M)`}>
                                                    <DebouncedTextField
                                                        ariaLabel={`Window ${index + 1} Cache Writes (${currencySymbol}/1M)`}
                                                        className={fieldControlClass}
                                                        id={`${baseId}-${index}-cache-writes`}
                                                        initialValue={String(rates.cacheWritePrice)}
                                                        onChange={(value) =>
                                                            updatePrice(index, "cacheWritePrice", parseClockPrice(value))
                                                        }
                                                    />
                                                </ProfileField>
                                                <ProfileField
                                                    htmlFor={`${baseId}-${index}-cache-reads`}
                                                    label={`Window Cache Reads (${currencySymbol}/1M)`}>
                                                    <DebouncedTextField
                                                        ariaLabel={`Window ${index + 1} Cache Reads (${currencySymbol}/1M)`}
                                                        className={fieldControlClass}
                                                        id={`${baseId}-${index}-cache-reads`}
                                                        initialValue={String(rates.cacheReadPrice)}
                                                        onChange={(value) =>
                                                            updatePrice(index, "cacheReadPrice", parseClockPrice(value))
                                                        }
                                                    />
                                                </ProfileField>
                                            </>
                                        ) : null}
                                    </ProfileInlineGrid>
                                ) : (
                                    <PricingTierEditor
                                        currencySymbol={currencySymbol}
                                        editable
                                        onChange={(bands) => updateBands(index, bands)}
                                        showCachePrices={showCachePrices}
                                        tiers={window.bands?.bands ?? []}
                                    />
                                )}
                                <ProfileActionRow>
                                    <VSCodeButton appearance="secondary" onClick={() => removeWindow(index)}>
                                        Remove Time Window
                                    </VSCodeButton>
                                </ProfileActionRow>
                            </>
                        ) : null}
                    </div>
                )
            })}
        </div>
    )
}

/** Parse a typed rate without emitting NaN. */
function parseClockPrice(value: string): number {
    const parsed = Number.parseFloat(value)
    return Number.isNaN(parsed) ? 0 : parsed
}
