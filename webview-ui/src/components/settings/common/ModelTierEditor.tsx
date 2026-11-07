import type { ContextWindowBand, ContextWindowTier } from "@shared/proto/dline/models/metadata"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { type ReactNode, useEffect, useId, useRef, useState } from "react"
import { ProfileActionRow, ProfileField, ProfileInlineGrid, ProfileSectionTitle } from "../profile-ui"
import { flushPendingDebouncedInputs } from "../utils/useDebouncedInput"
import { DebouncedTextField } from "./DebouncedTextField"
import { PriceSetFields } from "./PriceSetFields"

const fieldControlClass = "min-h-7 w-full"

/**
 * Build the alternating visual style for a tier card.
 *
 * @param index Tier position in the displayed list.
 * @returns Inline style that visually separates adjacent tiers.
 */
function getTierClassName(index: number): string {
    return `flex min-w-0 flex-col gap-2 rounded-xs border border-editor-widget-border p-2 ${
        index % 2 === 0 ? "bg-(--vscode-editor-background)" : "bg-(--vscode-sideBar-background)"
    }`
}

interface TierFieldProps {
    id: string
    label: string
    value: string
    onChange: (value: string) => void
}

/** Render one tier value with the shared Profile settings field hierarchy. */
function TierField({ id, label, value, onChange }: TierFieldProps) {
    return (
        <ProfileField htmlFor={id} label={label}>
            <DebouncedTextField
                ariaLabel={label}
                className={fieldControlClass}
                id={id}
                initialValue={value}
                onChange={onChange}
            />
        </ProfileField>
    )
}

interface TierHeaderProps {
    action?: ReactNode
    title: string
}

/** Render a tier editor heading with an optional action. */
function TierHeader({ action, title }: TierHeaderProps) {
    return (
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <ProfileSectionTitle className="text-xs uppercase tracking-wide text-description">{title}</ProfileSectionTitle>
            {action ? <ProfileActionRow>{action}</ProfileActionRow> : null}
        </div>
    )
}

/**
 * Parse a numeric tier field without emitting NaN.
 *
 * @param value Text entered by the user.
 * @returns Parsed number, or zero for an invalid value.
 */
function parseTierNumber(value: string): number {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
}

interface ContextTierEditorProps {
    tiers: ContextWindowTier[]
    editable: boolean
    onChange: (tiers: ContextWindowTier[]) => void
}

/**
 * Render context window tiers in read-only or editable mode.
 *
 * @param props Context tier values, editability, and update callback.
 * @returns Context tier editor section.
 */
export function ContextTierEditor({ tiers, editable, onChange }: ContextTierEditorProps) {
    const baseId = useId()

    /** Add a default editable context tier. */
    const addTier = () => {
        onChange([...tiers, { id: "standard", contextWindow: 128_000, label: "128K", apiModelSuffix: "" }])
    }

    /** Update one context tier without mutating props. */
    const updateTier = (index: number, updates: Partial<ContextWindowTier>) => {
        onChange(tiers.map((tier, tierIndex) => (tierIndex === index ? { ...tier, ...updates } : tier)))
    }

    /** Remove one context tier by index. */
    const removeTier = (index: number) => {
        onChange(tiers.filter((_, tierIndex) => tierIndex !== index))
    }

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <TierHeader
                action={editable ? <VSCodeButton onClick={addTier}>Add Context Tier</VSCodeButton> : undefined}
                title="Context Tiers"
            />
            {tiers.map((tier, index) => (
                <div className={getTierClassName(index)} key={`${tier.id}-${index}`}>
                    {editable ? (
                        <>
                            <ProfileInlineGrid>
                                <TierField
                                    id={`${baseId}-${index}-id`}
                                    label="Context Tier ID"
                                    onChange={(value) => updateTier(index, { id: value })}
                                    value={tier.id}
                                />
                                <TierField
                                    id={`${baseId}-${index}-window`}
                                    label="Context Tier Window"
                                    onChange={(value) => updateTier(index, { contextWindow: parseTierNumber(value) })}
                                    value={String(tier.contextWindow)}
                                />
                                <TierField
                                    id={`${baseId}-${index}-label`}
                                    label="Context Tier Label"
                                    onChange={(value) => updateTier(index, { label: value })}
                                    value={tier.label ?? ""}
                                />
                                <TierField
                                    id={`${baseId}-${index}-suffix`}
                                    label="API Model Suffix"
                                    onChange={(value) => updateTier(index, { apiModelSuffix: value })}
                                    value={tier.apiModelSuffix ?? ""}
                                />
                            </ProfileInlineGrid>
                            <ProfileActionRow>
                                <VSCodeButton appearance="secondary" onClick={() => removeTier(index)}>
                                    Remove Context Tier
                                </VSCodeButton>
                            </ProfileActionRow>
                        </>
                    ) : (
                        <div className="flex flex-col gap-1 text-sm">
                            <strong>{tier.id}</strong>
                            <span>{tier.label ?? tier.contextWindow.toLocaleString()}</span>
                            <span>{tier.contextWindow.toLocaleString()} tokens</span>
                            {tier.apiModelSuffix ? <span>API suffix: {tier.apiModelSuffix}</span> : null}
                        </div>
                    )}
                </div>
            ))}
        </div>
    )
}

interface PricingTierEditorProps {
    tiers: readonly ContextWindowBand[]
    editable: boolean
    ratesEditable?: boolean
    currencySymbol: string
    showCachePrices: boolean
    onChange?: (bands: ContextWindowBand[]) => void
}

/** Insert before the sole unbounded tail, retaining its declared prices. */
export function appendPricingTier(tiers: readonly ContextWindowBand[]): ContextWindowBand[] {
    const tail = tiers.at(-1)
    if (!tail) return [{ prices: {} }]
    if (tail.maxInputTokens !== undefined) return [...tiers, { prices: { ...tail.prices! } }]
    const bound = (tiers.at(-2)?.maxInputTokens ?? 0) + 128_000
    if (!Number.isSafeInteger(bound)) return [...tiers]
    return [...tiers.slice(0, -1), { maxInputTokens: bound, prices: { ...tail.prices! } }, tail]
}

/** Edit price bands independently from model context-capacity tiers. */
export function PricingTierEditor({
    tiers,
    editable,
    ratesEditable = editable,
    currencySymbol,
    showCachePrices,
    onChange,
}: PricingTierEditorProps) {
    const baseId = useId()
    const latest = useRef(tiers)
    const [invalidBound, setInvalidBound] = useState<number>()
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
        latest.current = tiers
    }, [tiers])
    const publish = (next: ContextWindowBand[]) => {
        latest.current = next
        onChange?.(next)
    }
    const updateTier = (index: number, updates: Partial<ContextWindowBand>) => {
        publish(latest.current.map((band, at) => (at === index ? { ...band, ...updates } : band)))
    }
    const removeTier = (index: number) =>
        afterInputFlush(() => {
            if (latest.current.length <= 1) return
            const next = latest.current.filter((_, at) => at !== index)
            publish(next.map((band, at) => (at === next.length - 1 ? { ...band, maxInputTokens: undefined } : band)))
        })
    return (
        <div className="flex min-w-0 flex-col gap-2">
            <TierHeader
                action={
                    editable ? (
                        <VSCodeButton onClick={() => afterInputFlush(() => publish(appendPricingTier(latest.current)))}>
                            Add Pricing Tier
                        </VSCodeButton>
                    ) : undefined
                }
                title="Pricing Tiers"
            />
            {flushFailed && (
                <span className="text-xs text-error" role="alert">
                    Pending inputs could not be saved. Retry before changing tiers.
                </span>
            )}
            {tiers.map((tier, index) => {
                const lower = index === 0 ? 0 : tiers[index - 1].maxInputTokens
                const range =
                    tier.maxInputTokens === undefined
                        ? index === 0
                            ? "All input sizes (unbounded)"
                            : `Above ${lower?.toLocaleString()} input tokens`
                        : `${lower?.toLocaleString()} ${index === 0 ? "≤" : "<"} input tokens ≤ ${tier.maxInputTokens.toLocaleString()}`
                return (
                    <div className={getTierClassName(index)} key={`band-${index}`}>
                        <strong className="text-xs">
                            Tier {index + 1} · {range}
                        </strong>
                        {editable ? (
                            <>
                                {index < tiers.length - 1 ? (
                                    <TierField
                                        id={`${baseId}-${index}-threshold`}
                                        label="Up To Input Tokens"
                                        onChange={(text) => {
                                            const value = Number(text)
                                            const lower = latest.current[index - 1]?.maxInputTokens ?? 0
                                            const upper = latest.current[index + 1]?.maxInputTokens ?? Number.POSITIVE_INFINITY
                                            const valid =
                                                Boolean(text.trim()) &&
                                                Number.isSafeInteger(value) &&
                                                value > lower &&
                                                value < upper
                                            setInvalidBound(valid ? undefined : index)
                                            if (valid) updateTier(index, { maxInputTokens: value })
                                        }}
                                        value={tier.maxInputTokens === undefined ? "" : String(tier.maxInputTokens)}
                                    />
                                ) : (
                                    <span className="text-xs text-description">No upper limit</span>
                                )}
                                {invalidBound === index && (
                                    <span className="text-xs text-error" role="alert">
                                        Enter a positive integer between the adjacent tier limits.
                                    </span>
                                )}
                                <ProfileActionRow>
                                    <VSCodeButton
                                        appearance="secondary"
                                        disabled={tiers.length <= 1}
                                        onClick={() => removeTier(index)}>
                                        Remove Pricing Tier
                                    </VSCodeButton>
                                </ProfileActionRow>
                            </>
                        ) : null}
                        <PriceSetFields
                            accessiblePrefix={`Tier ${index + 1}`}
                            currencySymbol={currencySymbol}
                            onChange={(prices) => updateTier(index, { prices })}
                            prices={tier.prices}
                            readOnly={!ratesEditable}
                            showCachePrices={showCachePrices}
                        />
                    </div>
                )
            })}
        </div>
    )
}
