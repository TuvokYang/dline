import { type ContextWindowBand, type ContextWindowTier, PriceSet } from "@shared/proto/dline/models/metadata"
import { readPriceSet } from "@shared/providers/pricing-shape"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { type ReactNode, useId } from "react"
import { ProfileActionRow, ProfileField, ProfileInlineGrid, ProfileSectionTitle } from "../profile-ui"
import { DebouncedTextField } from "./DebouncedTextField"

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
    currencySymbol: string
    showCachePrices: boolean
    onChange: (bands: ContextWindowBand[]) => void
}

/** Read the four published rates of one band. */
function bandRates(band: ContextWindowBand) {
    const prices = readPriceSet(band.prices)
    return prices
}

/**
 * Render usage-based tiered pricing in read-only or editable mode.
 *
 * Each tier's threshold is the maximum input-token usage for that price band;
 * it controls pricing, not the context window.
 *
 * @param props Pricing values, editability, currency, and update callback.
 * @returns Pricing tier editor section.
 */
export function PricingTierEditor({ tiers, editable, currencySymbol, showCachePrices, onChange }: PricingTierEditorProps) {
    const baseId = useId()

    /**
     * Add a band above the current highest one.
     *
     * Bands are ordered by their upper bound and the last one is unbounded, so a
     * new band is inserted before the unbounded band and becomes the new bound.
     */
    const addTier = () => {
        onChange([...tiers, { maxInputTokens: 128_000, prices: { inputPrice: 0, outputPrice: 0 } }])
    }

    /** Update one band's bound or rates without mutating props. */
    const updateTier = (index: number, updates: Partial<ContextWindowBand>) => {
        onChange(tiers.map((band, bandIndex) => (bandIndex === index ? { ...band, ...updates } : band)))
    }

    /** Replace one band's rates, leaving its bound alone. */
    const updateRates = (
        index: number,
        slot: "inputPrice" | "outputPrice" | "cacheWritePrice" | "cacheReadPrice",
        value: number,
    ) => {
        const band = tiers[index]
        updateTier(index, { prices: PriceSet.create({ ...band.prices, [slot]: value }) })
    }

    /** Remove one pricing tier by index. */
    const removeTier = (index: number) => {
        onChange(tiers.filter((_, tierIndex) => tierIndex !== index))
    }

    return (
        <div className="flex min-w-0 flex-col gap-2">
            <TierHeader
                action={editable ? <VSCodeButton onClick={addTier}>Add Pricing Tier</VSCodeButton> : undefined}
                title="Pricing Tiers"
            />
            {tiers.map((tier, index) => (
                <div className={getTierClassName(index)} key={`band-${index}`}>
                    {editable ? (
                        <>
                            <ProfileInlineGrid>
                                <TierField
                                    id={`${baseId}-${index}-threshold`}
                                    label="Up To Input Tokens"
                                    onChange={(value) => updateTier(index, { maxInputTokens: parseTierNumber(value) })}
                                    value={tier.maxInputTokens === undefined ? "" : String(tier.maxInputTokens)}
                                />
                                <TierField
                                    id={`${baseId}-${index}-input`}
                                    label={`Tier Input Price (${currencySymbol}/1M)`}
                                    onChange={(value) => updateRates(index, "inputPrice", parseTierNumber(value))}
                                    value={String(bandRates(tier).inputPrice)}
                                />
                                <TierField
                                    id={`${baseId}-${index}-output`}
                                    label={`Tier Output Price (${currencySymbol}/1M)`}
                                    onChange={(value) => updateRates(index, "outputPrice", parseTierNumber(value))}
                                    value={String(bandRates(tier).outputPrice)}
                                />
                                {showCachePrices ? (
                                    <>
                                        <TierField
                                            id={`${baseId}-${index}-cache-writes`}
                                            label={`Tier Cache Writes (${currencySymbol}/1M)`}
                                            onChange={(value) => updateRates(index, "cacheWritePrice", parseTierNumber(value))}
                                            value={String(bandRates(tier).cacheWritePrice)}
                                        />
                                        <TierField
                                            id={`${baseId}-${index}-cache-reads`}
                                            label={`Tier Cache Reads (${currencySymbol}/1M)`}
                                            onChange={(value) => updateRates(index, "cacheReadPrice", parseTierNumber(value))}
                                            value={String(bandRates(tier).cacheReadPrice)}
                                        />
                                    </>
                                ) : null}
                            </ProfileInlineGrid>
                            <ProfileActionRow>
                                <VSCodeButton appearance="secondary" onClick={() => removeTier(index)}>
                                    Remove Pricing Tier
                                </VSCodeButton>
                            </ProfileActionRow>
                        </>
                    ) : (
                        <div className="flex flex-col gap-1 text-sm">
                            <strong>
                                {tier.maxInputTokens === undefined
                                    ? "Above every declared bound"
                                    : `Up to ${tier.maxInputTokens.toLocaleString()} tokens`}
                            </strong>
                            <span>
                                Input: {currencySymbol}
                                {bandRates(tier).inputPrice}/1M
                            </span>
                            <span>
                                Output: {currencySymbol}
                                {bandRates(tier).outputPrice}/1M
                            </span>
                            {showCachePrices ? (
                                <span>
                                    Cache: {currencySymbol}
                                    {bandRates(tier).cacheWritePrice} write / {currencySymbol}
                                    {bandRates(tier).cacheReadPrice} read
                                </span>
                            ) : null}
                        </div>
                    )}
                </div>
            ))}
        </div>
    )
}
