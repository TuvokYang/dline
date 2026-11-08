import type { PriceSet } from "@shared/proto/dline/models/metadata"
import { useEffect, useId, useRef, useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { ProfileField, ProfileInlineGrid } from "../profile-ui"
import { DebouncedTextField } from "./DebouncedTextField"

interface PriceSetFieldsProps {
    prices: PriceSet | undefined
    currencySymbol: string
    showCachePrices: boolean
    /** Shown in front of every visible slot label, for a set that has no heading of its own. */
    prefix?: string
    /**
     * Scopes the accessible name without repeating the scope in every visible label.
     *
     * A card that already states its own title names the fields short, so a reader
     * sees "Input Price" under "Window 1" instead of "Window 1 Input Price" on every
     * row. The accessible name still carries the scope, so a control is never
     * announced — or queried — as an ambiguous "Input Price".
     */
    accessiblePrefix?: string
    readOnly?: boolean
    onChange?: (prices: PriceSet) => void
}

/** Edit declared slots without converting missing optional prices into zero. */
export function PriceSetFields({
    prices,
    currencySymbol,
    showCachePrices,
    prefix = "",
    accessiblePrefix = "",
    readOnly = false,
    onChange,
}: PriceSetFieldsProps) {
    const { t } = useUiTranslation()
    const id = useId()
    const latest = useRef(prices)
    useEffect(() => {
        latest.current = prices
    }, [prices])
    const [errors, setErrors] = useState<Partial<Record<keyof PriceSet, boolean>>>({})
    const slots: { key: keyof PriceSet; label: string; optional: boolean }[] = [
        { key: "inputPrice", label: t("settings.ui.inputPrice"), optional: false },
        { key: "outputPrice", label: t("settings.ui.outputPrice"), optional: false },
        ...(showCachePrices || (readOnly && (prices?.cacheReadPrice !== undefined || prices?.cacheWritePrice !== undefined))
            ? [
                  { key: "cacheWritePrice" as const, label: t("settings.ui.cacheWrites"), optional: true },
                  { key: "cacheReadPrice" as const, label: t("settings.ui.cacheReads"), optional: true },
              ]
            : []),
        ...(prices?.thinkingOutputPrice !== undefined
            ? [{ key: "thinkingOutputPrice" as const, label: t("settings.ui.thinkingOutput"), optional: true }]
            : []),
    ]

    const update = (slot: keyof PriceSet, text: string, optional: boolean) => {
        const empty = text.trim() === ""
        const value = optional && empty ? undefined : Number(text)
        if ((!optional && empty) || (value !== undefined && (!Number.isFinite(value) || value < 0))) {
            setErrors((current) => ({ ...current, [slot]: true }))
            return
        }
        setErrors((current) => ({ ...current, [slot]: undefined }))
        const next = { ...latest.current, [slot]: value }
        latest.current = next
        onChange?.(next)
    }

    return (
        <ProfileInlineGrid>
            {slots.map(({ key, label, optional }) => {
                const title = t("settings.ui.priceSlot", { scope: prefix, label, symbol: currencySymbol })
                const accessibleName = t("settings.ui.scopedField", { scope: accessiblePrefix, label: title })
                return (
                    <ProfileField htmlFor={readOnly ? undefined : `${id}-${key}`} key={key} label={title}>
                        {readOnly ? (
                            <span className="text-xs" data-price-slot={key}>
                                {prices?.[key] === undefined
                                    ? t("settings.ui.notPublished")
                                    : `${currencySymbol}${prices[key].toLocaleString("en-US", { maximumFractionDigits: 12 })}`}
                            </span>
                        ) : (
                            <DebouncedTextField
                                ariaLabel={accessibleName}
                                className="min-h-7 w-full"
                                id={`${id}-${key}`}
                                initialValue={prices?.[key] === undefined ? "" : String(prices[key])}
                                onChange={(value) => update(key, value, optional)}
                                placeholder={optional ? t("settings.ui.notPublished") : t("settings.ui.enterPrice")}
                            />
                        )}
                        {errors[key] && (
                            <span className="text-xs text-error" role="alert">
                                {t("settings.ui.priceInvalid")}
                            </span>
                        )}
                    </ProfileField>
                )
            })}
        </ProfileInlineGrid>
    )
}
