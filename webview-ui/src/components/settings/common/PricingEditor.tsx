import { ModelPricing, PricingDayRule, type PricingSchedule, type TimeOfDayPricing } from "@shared/proto/dline/models/metadata"
import {
    emptyPricingSchedule,
    flatMeteredPricing,
    type PricingShapeKind,
    readPricingShape,
    withPricingShape,
} from "@shared/providers/pricing-shape"
import { VSCodeButton, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { getCurrencySymbol, SUPPORTED_CURRENCY_CODES } from "@/utils/currency"
import { ProfileField, ProfileSection, ProfileSectionTitle } from "../profile-ui"
import { flushPendingDebouncedInputs } from "../utils/useDebouncedInput"
import { DebouncedTextField } from "./DebouncedTextField"
import { appendPricingTier, PricingTierEditor } from "./ModelTierEditor"
import { PriceSetFields } from "./PriceSetFields"
import { TimeWindowEditor } from "./TimeWindowEditor"

interface PricingEditorProps {
    pricing?: ModelPricing
    defaults?: ModelPricing
    fixedShape?: PricingShapeKind
    tiersEditable?: boolean
    showCachePrices?: boolean
    readOnly?: boolean
    onChange?: (pricing: ModelPricing) => void
    onReset?: () => void
}

const fingerprint = (pricing: ModelPricing) => JSON.stringify(ModelPricing.toJSON(pricing))

/** One complete local declaration; incoming stale echoes cannot drop a sibling edit. */
export function PricingEditor({
    pricing,
    defaults,
    fixedShape,
    tiersEditable = false,
    showCachePrices = false,
    readOnly = false,
    onChange,
    onReset,
}: PricingEditorProps) {
    const id = useId()
    const incoming = useMemo(() => pricing ?? defaults ?? flatMeteredPricing(undefined, undefined), [pricing, defaults])
    const incomingKey = fingerprint(incoming)
    const [draft, setDraft] = useState(incoming)
    const current = useRef(draft)
    const pending = useRef(new Set<string>())
    const shapes = useRef<Partial<Record<PricingShapeKind, ModelPricing>>>({})
    const [flushFailed, setFlushFailed] = useState(false)
    const afterInputFlush = (change: () => void) => {
        void flushPendingDebouncedInputs()
            .then(() => {
                setFlushFailed(false)
                change()
            })
            .catch(() => setFlushFailed(true))
    }

    useEffect(() => {
        if (pending.current.has(incomingKey) && incomingKey !== fingerprint(current.current)) return
        if (incomingKey !== fingerprint(current.current)) pending.current.clear()
        current.current = incoming
        setDraft(incoming)
    }, [incoming, incomingKey])

    const publish = (next: ModelPricing) => {
        if (readOnly || !onChange) return
        pending.current.add(fingerprint(next))
        current.current = next
        setDraft(next)
        onChange(next)
    }
    const reset = () =>
        afterInputFlush(() => {
            pending.current.clear()
            shapes.current = {}
            const next = defaults ?? flatMeteredPricing(undefined, undefined)
            current.current = next
            setDraft(next)
            onReset?.()
        })
    const declaration = readOnly ? (pricing ?? defaults) : draft
    const currency = declaration?.currency ?? "USD"
    const symbol = getCurrencySymbol(currency)
    const shape = readPricingShape(declaration)
    const switchShape = (kind: PricingShapeKind) =>
        afterInputFlush(() => {
            const latest = current.current
            shapes.current[readPricingShape(latest)] = latest
            const next = shapes.current[kind] ?? withPricingShape(latest, kind, currency)
            publish({ ...next, currency })
        })
    const replaceTime = (update: (time: TimeOfDayPricing) => TimeOfDayPricing) => {
        const latest = current.current
        publish({ currency: latest.currency, strategy: { timeOfDay: update(latest.strategy!.timeOfDay!) } })
    }
    const updateSchedule = (updates: Partial<PricingSchedule>) =>
        replaceTime((time) => ({
            ...time,
            schedule: { ...(time.schedule ?? emptyPricingSchedule()), ...updates },
        }))
    const replaceDefault = (kind: "prices" | "bands") =>
        replaceTime((time) => {
            const prices = time.defaultPrices ?? time.defaultBands?.bands[0]?.prices ?? {}
            return {
                ...time,
                defaultPrices: kind === "prices" ? prices : undefined,
                defaultBands: kind === "bands" ? (time.defaultBands ?? { bands: [{ prices }] }) : undefined,
            }
        })
    const time = declaration?.strategy?.timeOfDay
    const resetButton = !readOnly && onReset && (
        <VSCodeButton appearance="secondary" onClick={reset}>
            Reset Pricing
        </VSCodeButton>
    )

    if (!declaration?.strategy) {
        return <p className="text-xs text-description">Pricing not published</p>
    }
    if (!readOnly && fixedShape && shape !== fixedShape) {
        return (
            <ProfileSection>
                <p role="alert">
                    This legacy pricing cannot be converted into published time windows automatically. Reset pricing to inherit
                    the catalog declaration.
                </p>
                {resetButton}
            </ProfileSection>
        )
    }
    return (
        <ProfileSection>
            <div className="flex items-center justify-between gap-2">
                <ProfileSectionTitle className="text-xs uppercase tracking-wide text-description">Pricing</ProfileSectionTitle>
                {resetButton}
            </div>
            {flushFailed && (
                <span className="text-xs text-error" role="alert">
                    Pending inputs could not be saved. Retry before changing pricing structure.
                </span>
            )}
            {!readOnly && !fixedShape && (
                <ProfileField htmlFor={`${id}-shape`} label="Pricing Mode">
                    <Select onValueChange={(value) => switchShape(value as PricingShapeKind)} value={shape}>
                        <SelectTrigger className="min-h-7 w-full" id={`${id}-shape`}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="flat">Flat rate</SelectItem>
                            <SelectItem value="contextWindow">By context size</SelectItem>
                            <SelectItem value="timeOfDay">By time of day</SelectItem>
                        </SelectContent>
                    </Select>
                </ProfileField>
            )}
            <ProfileField htmlFor={readOnly ? undefined : `${id}-currency`} label="Currency">
                {readOnly ? (
                    <span className="text-xs">{currency} per 1M tokens</span>
                ) : (
                    <Select onValueChange={(value) => publish({ ...current.current, currency: value })} value={currency}>
                        <SelectTrigger className="min-h-7 w-full" id={`${id}-currency`}>
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            {SUPPORTED_CURRENCY_CODES.map((code) => (
                                <SelectItem key={code} value={code}>{`${code} (${getCurrencySymbol(code)})`}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>
                )}
            </ProfileField>
            {shape === "flat" && (
                <>
                    <PriceSetFields
                        currencySymbol={symbol}
                        onChange={(prices) =>
                            publish({
                                currency: current.current.currency,
                                strategy: { flat: { prices } },
                            })
                        }
                        prices={declaration.strategy?.flat?.prices}
                        readOnly={readOnly}
                        showCachePrices={showCachePrices}
                    />
                    {!readOnly && tiersEditable && (
                        <VSCodeButton
                            onClick={() =>
                                afterInputFlush(() => {
                                    const prices = current.current.strategy!.flat!.prices ?? {}
                                    publish({
                                        currency: current.current.currency,
                                        strategy: {
                                            contextWindow: { bands: appendPricingTier([{ prices }]) },
                                        },
                                    })
                                })
                            }>
                            Add Pricing Tier
                        </VSCodeButton>
                    )}
                </>
            )}
            {shape === "contextWindow" && (
                <PricingTierEditor
                    currencySymbol={symbol}
                    editable={!readOnly && tiersEditable}
                    onChange={(bands) => publish({ currency: current.current.currency, strategy: { contextWindow: { bands } } })}
                    ratesEditable={!readOnly}
                    showCachePrices={showCachePrices}
                    tiers={declaration.strategy!.contextWindow!.bands}
                />
            )}
            {time && (
                <>
                    <p className="m-0 text-[11px] text-description">
                        {time.schedule?.dayRule === PricingDayRule.PRICING_DAY_RULE_WEEKDAYS
                            ? "Weekdays"
                            : time.schedule?.dayRule === PricingDayRule.PRICING_DAY_RULE_ALL_DAYS
                              ? "All days"
                              : "Applicable days not declared"}
                        .
                        {time.schedule?.defaultOnPublicHolidays
                            ? ` Public holidays (${time.schedule.holidayCalendar || "calendar not declared"}) use default rates.`
                            : ""}
                        {" Configuration, not today's effective schedule. Default rates cover gaps and non-applicable days."}
                    </p>
                    {!readOnly && !fixedShape && (
                        <>
                            <ProfileField htmlFor={`${id}-offset`} label="Seller UTC offset (minutes)">
                                <DebouncedTextField
                                    ariaLabel="Seller UTC offset (minutes)"
                                    id={`${id}-offset`}
                                    initialValue={String(time.schedule?.timezoneOffsetMinutes ?? 0)}
                                    onChange={(text) => {
                                        const value = Number(text)
                                        if (text.trim() && Number.isInteger(value) && value >= -840 && value <= 840)
                                            updateSchedule({ timezoneOffsetMinutes: value })
                                    }}
                                />
                            </ProfileField>
                            <ProfileField htmlFor={`${id}-days`} label="Apply windows on">
                                <Select
                                    onValueChange={(value) => updateSchedule({ dayRule: Number(value) as PricingDayRule })}
                                    value={String(time.schedule?.dayRule ?? PricingDayRule.PRICING_DAY_RULE_ALL_DAYS)}>
                                    <SelectTrigger id={`${id}-days`}>
                                        <SelectValue />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value={String(PricingDayRule.PRICING_DAY_RULE_ALL_DAYS)}>All days</SelectItem>
                                        <SelectItem value={String(PricingDayRule.PRICING_DAY_RULE_WEEKDAYS)}>Weekdays</SelectItem>
                                    </SelectContent>
                                </Select>
                            </ProfileField>
                            <VSCodeCheckbox
                                checked={time.schedule?.defaultOnPublicHolidays === true}
                                onChange={(event) =>
                                    updateSchedule({
                                        defaultOnPublicHolidays: (event.target as HTMLInputElement).checked === true,
                                        holidayCalendar: current.current.strategy!.timeOfDay!.schedule?.holidayCalendar || "CN",
                                    })
                                }>
                                Use default rates on Chinese public holidays
                            </VSCodeCheckbox>
                        </>
                    )}
                    {!readOnly && !fixedShape && (
                        <ProfileField htmlFor={`${id}-default-kind`} label="Default Rate">
                            <Select
                                onValueChange={(value) => afterInputFlush(() => replaceDefault(value as "prices" | "bands"))}
                                value={time.defaultBands ? "bands" : "prices"}>
                                <SelectTrigger id={`${id}-default-kind`}>
                                    <SelectValue />
                                </SelectTrigger>
                                <SelectContent>
                                    <SelectItem value="prices">Single rate</SelectItem>
                                    <SelectItem value="bands">By context size</SelectItem>
                                </SelectContent>
                            </Select>
                        </ProfileField>
                    )}
                    {time.defaultBands ? (
                        <PricingTierEditor
                            currencySymbol={symbol}
                            editable={!readOnly && tiersEditable}
                            onChange={(bands) =>
                                replaceTime((latest) => ({ ...latest, defaultPrices: undefined, defaultBands: { bands } }))
                            }
                            ratesEditable={!readOnly}
                            showCachePrices={showCachePrices}
                            tiers={time.defaultBands.bands}
                        />
                    ) : (
                        <PriceSetFields
                            currencySymbol={symbol}
                            onChange={(prices) =>
                                replaceTime((latest) => ({ ...latest, defaultBands: undefined, defaultPrices: prices }))
                            }
                            prefix="Default"
                            prices={time.defaultPrices}
                            readOnly={readOnly}
                            showCachePrices={showCachePrices}
                        />
                    )}
                    <TimeWindowEditor
                        currencySymbol={symbol}
                        defaultRate={{ prices: time.defaultPrices, bands: time.defaultBands }}
                        editable={!readOnly && tiersEditable}
                        onChange={(windows) => replaceTime((latest) => ({ ...latest, timeWindows: windows }))}
                        ratesEditable={!readOnly}
                        showCachePrices={showCachePrices}
                        timezoneOffsetMinutes={time.schedule?.timezoneOffsetMinutes ?? 0}
                        windows={time.timeWindows}
                    />
                </>
            )}
        </ProfileSection>
    )
}
