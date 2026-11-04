import type { PriceSet } from "@shared/proto/dline/models/metadata"
import { useEffect, useId, useRef, useState } from "react"
import { ProfileField, ProfileInlineGrid } from "../profile-ui"
import { DebouncedTextField } from "./DebouncedTextField"

interface PriceSetFieldsProps {
    prices: PriceSet | undefined
    currencySymbol: string
    showCachePrices: boolean
    prefix?: string
    readOnly?: boolean
    onChange?: (prices: PriceSet) => void
}

/** Edit declared slots without converting missing optional prices into zero. */
export function PriceSetFields({
    prices,
    currencySymbol,
    showCachePrices,
    prefix = "",
    readOnly = false,
    onChange,
}: PriceSetFieldsProps) {
    const id = useId()
    const latest = useRef(prices)
    useEffect(() => {
        latest.current = prices
    }, [prices])
    const [errors, setErrors] = useState<Partial<Record<keyof PriceSet, string>>>({})
    const slots: { key: keyof PriceSet; label: string; optional: boolean }[] = [
        { key: "inputPrice", label: "Input Price", optional: false },
        { key: "outputPrice", label: "Output Price", optional: false },
        ...(showCachePrices || (readOnly && (prices?.cacheReadPrice !== undefined || prices?.cacheWritePrice !== undefined))
            ? [
                  { key: "cacheWritePrice" as const, label: "Cache Writes", optional: true },
                  { key: "cacheReadPrice" as const, label: "Cache Reads", optional: true },
              ]
            : []),
        ...(prices?.thinkingOutputPrice !== undefined
            ? [{ key: "thinkingOutputPrice" as const, label: "Thinking Output", optional: true }]
            : []),
    ]

    const update = (slot: keyof PriceSet, text: string, optional: boolean) => {
        const empty = text.trim() === ""
        const value = optional && empty ? undefined : Number(text)
        if ((!optional && empty) || (value !== undefined && (!Number.isFinite(value) || value < 0))) {
            setErrors((current) => ({ ...current, [slot]: "Enter a finite non-negative price." }))
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
                const title = `${prefix ? `${prefix} ` : ""}${label} (${currencySymbol}/1M tokens)`
                return (
                    <ProfileField htmlFor={readOnly ? undefined : `${id}-${key}`} key={key} label={title}>
                        {readOnly ? (
                            <span className="text-xs" data-price-slot={key}>
                                {prices?.[key] === undefined
                                    ? "Not published"
                                    : `${currencySymbol}${prices[key].toLocaleString("en-US", { maximumFractionDigits: 12 })}`}
                            </span>
                        ) : (
                            <DebouncedTextField
                                ariaLabel={title}
                                className="min-h-7 w-full"
                                id={`${id}-${key}`}
                                initialValue={prices?.[key] === undefined ? "" : String(prices[key])}
                                onChange={(value) => update(key, value, optional)}
                                placeholder={optional ? "Not published" : "Enter price"}
                            />
                        )}
                        {errors[key] && (
                            <span className="text-xs text-error" role="alert">
                                {errors[key]}
                            </span>
                        )}
                    </ProfileField>
                )
            })}
        </ProfileInlineGrid>
    )
}
