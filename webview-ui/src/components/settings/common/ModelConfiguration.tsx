import type { ModelInfo } from "@shared/proto/dline/models"
import {
    type ContextWindowBand,
    type ModelCapabilities,
    type ModelPricing,
    ServerTool,
} from "@shared/proto/dline/models/metadata"
import {
    flatMeteredPricing,
    type PriceSlot,
    type PricingShapeKind,
    readBands,
    readCurrency,
    readPriceSet,
    readPricingShape,
    withBands,
    withPricingShape,
    withTimeOfDayDefaultPrices,
    withTimeWindows,
} from "@shared/providers/pricing-shape"
import { declaredServerTools, isServerToolEnabled, withServerToolSwitch } from "@shared/providers/server-tool-switches"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useId, useState } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { getCurrencySymbol, SUPPORTED_CURRENCY_CODES } from "@/utils/currency"
import { ProfileDisclosure, ProfileField, ProfileInlineGrid, ProfileSection, ProfileSectionTitle } from "../profile-ui"
import { DebouncedTextField } from "./DebouncedTextField"
import { ContextTierEditor, PricingTierEditor } from "./ModelTierEditor"
import { TimeWindowEditor } from "./TimeWindowEditor"

const BUILT_IN_CONTEXT_WINDOW = 128_000
const BUILT_IN_MAX_TOKENS = 8_192

type CapabilityCheckField =
    | "supportsImages"
    | "supportsPromptCache"
    | "supportsTools"
    | "hostedWebSearchEnabled"
    | "hostedWebFetchEnabled"
    | "supportsBrowserAction"

type HostedToolCheckField = "hostedWebSearchEnabled" | "hostedWebFetchEnabled"

const HOSTED_TOOL_BY_CHECK: Readonly<Record<HostedToolCheckField, ServerTool>> = {
    hostedWebSearchEnabled: ServerTool.WEB_SEARCH,
    hostedWebFetchEnabled: ServerTool.WEB_FETCH,
}

const fieldControlClass = "min-h-7 w-full"

/**
 * Props for the ModelConfiguration component
 */
interface ModelConfigurationProps {
    // Provider capability overrides edited by this component.
    capabilities?: ModelCapabilities

    // Provider pricing overrides edited by this component.
    pricing?: ModelPricing

    // Update callback for provider capabilities.
    onCapabilitiesUpdate: (updates: Partial<ModelCapabilities>) => void

    // Update callback for provider pricing.
    onPricingUpdate: (updates: Partial<ModelPricing>) => void

    // Hosted server tools the user switched off for this profile. Absent means
    // "follow the model declaration", which is why an empty list is meaningful here
    // and would not be meaningful inside the declaration itself.
    disabledServerTools?: readonly ServerTool[]

    // Update callback for the hosted server tool switches.
    onDisabledServerToolsUpdate?: (disabledServerTools: ServerTool[]) => void

    // Which fields to display (data-driven)
    fields: {
        // Capabilities related fields
        capabilities?: Array<
            | "maxTokens"
            | "contextWindow"
            | "contextWindowTiers"
            | "supportsImages"
            | "supportsPromptCache"
            | "supportsTools"
            | "hostedWebSearch"
            | "hostedWebFetch"
            | "supportsBrowserAction"
            | "temperature"
        >
        // Pricing related fields (currency automatically shown first)
        pricing?: Array<"inputPrice" | "outputPrice" | "cacheWritesPrice" | "cacheReadsPrice" | "pricingTiers">
    }

    // Default values (for placeholders)
    defaults?: Partial<ModelInfo>

    // Whether tier arrays can be added, edited, and removed.
    tiersEditable?: boolean

    // Whether pricing tiers are an explicit provider override, including an empty list.
    pricingTiersEnabled?: boolean

    // Optional provider-selected context window projection and update handler.
    contextWindowValue?: number
    onContextWindowUpdate?: (value: number) => void
}

/**
 * Reusable Model Configuration component for provider settings.
 * Displays a collapsible section with model capabilities and pricing.
 * All edits are stored in provider-specific capabilities and pricing.
 */
export const ModelConfiguration = ({
    capabilities: capabilityOverrides,
    pricing: pricingOverrides,
    onCapabilitiesUpdate,
    onPricingUpdate,
    disabledServerTools,
    onDisabledServerToolsUpdate,
    fields,
    defaults,
    tiersEditable = false,
    pricingTiersEnabled = false,
    contextWindowValue: selectedContextWindowValue,
    onContextWindowUpdate,
}: ModelConfigurationProps) => {
    const fieldId = useId()
    const temperatureId = `${fieldId}-temperature`
    const contextWindowId = `${fieldId}-context-window`
    const maxTokensId = `${fieldId}-max-tokens`
    const currencyId = `${fieldId}-currency`
    const pricingShapeId = `${fieldId}-pricing-shape`
    const inputPriceId = `${fieldId}-input-price`
    const outputPriceId = `${fieldId}-output-price`
    const cacheWritesPriceId = `${fieldId}-cache-writes-price`
    const cacheReadsPriceId = `${fieldId}-cache-reads-price`
    const [draftChecks, setDraftChecks] = useState<Partial<Record<CapabilityCheckField, boolean>>>({})
    // Only the setter is used: the effect below reconciles against its own updater.
    const [, setPendingChecks] = useState<Partial<Record<CapabilityCheckField, boolean>>>({})
    // Show registry defaults until the user edits them; edits persist as provider overrides.
    const [draftContextTiers, setDraftContextTiers] = useState(
        capabilityOverrides?.contextWindowTiers ?? defaults?.capabilities?.contextWindowTiers ?? [],
    )
    /**
     * Rates typed before the saved profile echoes back.
     *
     * Each keystroke reaches the host asynchronously, so patching the stale
     * `pricing` prop per slot dropped every rate but the last one.
     */
    const [draftFlatPrices, setDraftFlatPrices] = useState<
        { inputPrice: number; outputPrice: number; cacheWritePrice?: number; cacheReadPrice?: number } | undefined
    >(undefined)
    const [draftPricingBands, setDraftPricingBands] = useState(() =>
        pricingTiersEnabled
            ? readBands(pricingOverrides)
            : readBands(pricingOverrides).length > 0
              ? readBands(pricingOverrides)
              : readBands(defaults?.pricing),
    )

    // Extract current values from provider overrides
    const capabilities: ModelCapabilities = capabilityOverrides ?? ({} as ModelCapabilities)
    const pricing: ModelPricing = pricingOverrides ?? ({} as ModelPricing)
    const temperature = capabilities.temperature

    useEffect(() => {
        setPendingChecks((pending) => {
            const nextPending = { ...pending }
            const nextDraft = { ...draftChecks }
            let changed = false
            for (const field of [
                "supportsImages",
                "supportsPromptCache",
                "supportsTools",
                "hostedWebSearchEnabled",
                "hostedWebFetchEnabled",
                "supportsBrowserAction",
            ] as const) {
                const expected = pending[field]
                const persisted = (() => {
                    switch (field) {
                        case "supportsImages":
                            return capabilities.supportsImages ?? false
                        case "supportsPromptCache":
                            return capabilities.supportsPromptCache ?? true
                        case "supportsTools":
                            return capabilities.supportsTools ?? defaults?.capabilities?.supportsTools ?? false
                        case "hostedWebSearchEnabled":
                        case "hostedWebFetchEnabled":
                            return isServerToolEnabled(HOSTED_TOOL_BY_CHECK[field], disabledServerTools)
                        case "supportsBrowserAction":
                            return capabilities.supportsBrowserAction ?? defaults?.capabilities?.supportsBrowserAction ?? false
                    }
                })()
                if (expected !== undefined && persisted === expected) {
                    delete nextPending[field]
                    delete nextDraft[field]
                    changed = true
                }
            }
            if (changed) {
                setDraftChecks(nextDraft)
            }
            return changed ? nextPending : pending
        })
    }, [
        capabilities.supportsImages,
        capabilities.supportsPromptCache,
        capabilities.supportsTools,
        capabilities.supportsBrowserAction,
        disabledServerTools,
        defaults?.capabilities?.supportsTools,
        defaults?.capabilities?.supportsBrowserAction,
        draftChecks,
    ])

    useEffect(() => {
        setDraftContextTiers(capabilityOverrides?.contextWindowTiers ?? defaults?.capabilities?.contextWindowTiers ?? [])
    }, [capabilityOverrides?.contextWindowTiers, defaults?.capabilities?.contextWindowTiers])

    useEffect(() => {
        setDraftPricingBands(
            pricingTiersEnabled
                ? readBands(pricingOverrides)
                : readBands(pricingOverrides).length > 0
                  ? readBands(pricingOverrides)
                  : readBands(defaults?.pricing),
        )
    }, [pricingOverrides, defaults?.pricing, pricingTiersEnabled])

    // The persisted pricing has arrived, so the local draft is no longer needed.
    const persistedFlatPrices = pricing.metered?.strategy?.flat?.prices
    useEffect(() => {
        if (persistedFlatPrices) {
            setDraftFlatPrices(undefined)
        }
    }, [persistedFlatPrices])

    // Registry pricing remains visible until a profile override replaces one field.
    const currency = readCurrency(pricing) ?? readCurrency(defaults?.pricing) ?? "USD"
    // Show the shape the profile actually stores; fall back to the catalog's
    // shape only while the profile has not overridden pricing at all.
    const pricingShape = pricing.metered ? readPricingShape(pricing) : readPricingShape(defaults?.pricing)
    // The default rate and the windows belong to whichever price is on screen, so
    // a profile that has not overridden pricing yet still shows the catalog's terms.
    const timeOfDay = pricing.metered?.strategy?.timeOfDay ?? defaults?.pricing?.metered?.strategy?.timeOfDay
    const timeWindows = timeOfDay?.timeWindows ?? []
    const defaultRate = readPriceSet(timeOfDay?.defaultPrices)
    const currencySymbol = getCurrencySymbol(currency)
    const defaultPrices = readPriceSet(defaults?.pricing?.metered?.strategy?.flat?.prices)
    /**
     * Cache rates that a price list actually published.
     *
     * `readPriceSet` substitutes 0 for display, but a write must not turn
     * "not published" into "published as 0"; only an existing rate carries over.
     */
    const publishedCachePrices = {
        cacheWritePrice:
            pricing.metered?.strategy?.flat?.prices?.cacheWritePrice ??
            defaults?.pricing?.metered?.strategy?.flat?.prices?.cacheWritePrice,
        cacheReadPrice:
            pricing.metered?.strategy?.flat?.prices?.cacheReadPrice ??
            defaults?.pricing?.metered?.strategy?.flat?.prices?.cacheReadPrice,
    }
    const inputPriceValue =
        draftFlatPrices?.inputPrice ?? pricing.metered?.strategy?.flat?.prices?.inputPrice ?? defaultPrices.inputPrice
    const outputPriceValue =
        draftFlatPrices?.outputPrice ?? pricing.metered?.strategy?.flat?.prices?.outputPrice ?? defaultPrices.outputPrice
    const cacheWritesPriceValue =
        draftFlatPrices?.cacheWritePrice ??
        pricing.metered?.strategy?.flat?.prices?.cacheWritePrice ??
        defaultPrices.cacheWritePrice
    const cacheReadsPriceValue =
        draftFlatPrices?.cacheReadPrice ?? pricing.metered?.strategy?.flat?.prices?.cacheReadPrice ?? defaultPrices.cacheReadPrice

    // Update capability field
    const updateCapability = (field: keyof ModelCapabilities, value: ModelCapabilities[keyof ModelCapabilities]) => {
        onCapabilitiesUpdate({ [field]: value } as Partial<ModelCapabilities>)
    }

    /** Optimistically update a capability checkbox until its persisted echo arrives. */
    const updateCheck = (
        field: "supportsImages" | "supportsPromptCache" | "supportsTools" | "supportsBrowserAction",
        value: boolean,
    ) => {
        setDraftChecks((draft) => ({ ...draft, [field]: value }))
        setPendingChecks((pending) => ({ ...pending, [field]: value }))
        updateCapability(field, value)
    }

    /**
     * Toggle one hosted web tool switch. This writes the profile-owned disable
     * list and never the model's capability declaration, so turning the switch off
     * and on again cannot erase what the model is actually able to do.
     */
    const updateHostedToolCheck = (field: HostedToolCheckField, value: boolean) => {
        setDraftChecks((draft) => ({ ...draft, [field]: value }))
        setPendingChecks((pending) => ({ ...pending, [field]: value }))
        onDisabledServerToolsUpdate?.(withServerToolSwitch(disabledServerTools, HOSTED_TOOL_BY_CHECK[field], value))
    }

    /** Persist context tier changes while keeping the editor responsive before profile echo. */
    const updateContextTiers = (tiers: ModelCapabilities["contextWindowTiers"]) => {
        const nextTiers = tiers ?? []
        setDraftContextTiers(nextTiers)
        updateCapability("contextWindowTiers", nextTiers)
    }

    /**
     * Persist one flat rate, leaving the other slots as they are.
     *
     * The saved profile echoes back asynchronously, so consecutive edits must not
     * each patch the same stale `pricing` prop: doing that dropped every rate but
     * the last one, and a Profile that started without pricing lost the first
     * edit entirely because there was no flat strategy to patch.
     */
    const updateFlatPrice = (slot: PriceSlot, value: number | undefined) => {
        const current = draftFlatPrices ?? {
            inputPrice: inputPriceValue,
            outputPrice: outputPriceValue,
            ...publishedCachePrices,
        }
        const next = { ...current, [slot]: value }
        setDraftFlatPrices(next)
        onPricingUpdate(
            flatMeteredPricing(next.inputPrice, next.outputPrice, next.cacheWritePrice, next.cacheReadPrice, currency),
        )
    }

    /**
     * Switch the metered strategy the profile uses.
     *
     * The schema allows exactly one strategy, so the user picks the shape here
     * and the editor below shows only that shape's fields. Rates already typed
     * are carried across so a switch never silently resets a published price.
     */
    const updatePricingShape = (kind: PricingShapeKind) => {
        // Reshape whichever price the profile is actually showing. A profile that
        // has not overridden pricing yet displays the catalog's rates, so
        // switching its shape must carry those, not write a new zero rate.
        const source = pricing.metered ? pricing : (defaults?.pricing ?? pricing)
        const next = withPricingShape(source, kind, currency)
        if (next) {
            onPricingUpdate(next)
        }
    }

    /** Persist band changes while keeping the editor responsive before profile echo. */
    const updatePricingBands = (bands: ContextWindowBand[]) => {
        setDraftPricingBands(bands)
        const next = withBands(pricing, bands) ?? withBands(defaults?.pricing, bands)
        if (next) {
            onPricingUpdate(next)
        }
    }

    /**
     * Persist the rate that covers every instant no window covers.
     *
     * The default is one rate set, so an edit patches exactly one slot and
     * leaves the windows untouched.
     */
    const updateTimeOfDayDefault = (slot: PriceSlot, value: number) => {
        const current = readPriceSet(timeOfDay?.defaultPrices ?? defaults?.pricing?.metered?.strategy?.timeOfDay?.defaultPrices)
        onPricingUpdate(withTimeOfDayDefaultPrices(pricing, { ...current, [slot]: value }, currency))
    }

    /** Persist the whole window list, which is what an add, remove, or boundary edit amounts to. */
    const updateTimeWindows = (windows: Parameters<typeof withTimeWindows>[1]) => {
        onPricingUpdate(withTimeWindows(pricing, windows, currency))
    }

    /** Persist the currency a metered price is quoted in. */
    const updateCurrency = (currency: string) => {
        const next = pricing.metered ? { ...pricing, metered: { ...pricing.metered, currency } } : undefined
        if (next) {
            onPricingUpdate(next)
        }
    }

    // Update temperature
    const updateTemperature = (value: number) => {
        onCapabilitiesUpdate({ temperature: value })
    }

    // Parse price value
    const parsePrice = (value: string, defaultValue = 0): number => {
        const parsed = Number.parseFloat(value)
        return Number.isNaN(parsed) ? defaultValue : parsed
    }

    const capabilityFields = fields.capabilities ?? []
    const pricingFields = fields.pricing ?? []
    const supportsImages = draftChecks.supportsImages ?? capabilities.supportsImages ?? false
    const supportsPromptCache = draftChecks.supportsPromptCache ?? capabilities.supportsPromptCache ?? true
    const supportsTools =
        draftChecks.supportsTools ?? capabilities.supportsTools ?? defaults?.capabilities?.supportsTools ?? false
    const modelServerTools = declaredServerTools(defaults?.capabilities)
    const modelDeclaresHostedWebSearch = modelServerTools.includes(ServerTool.WEB_SEARCH)
    const hostedWebSearchEnabled =
        draftChecks.hostedWebSearchEnabled ?? isServerToolEnabled(ServerTool.WEB_SEARCH, disabledServerTools)
    const modelDeclaresHostedWebFetch = modelServerTools.includes(ServerTool.WEB_FETCH)
    const hostedWebFetchEnabled =
        draftChecks.hostedWebFetchEnabled ?? isServerToolEnabled(ServerTool.WEB_FETCH, disabledServerTools)
    const supportsBrowserAction =
        draftChecks.supportsBrowserAction ??
        capabilities.supportsBrowserAction ??
        defaults?.capabilities?.supportsBrowserAction ??
        false
    const hasOptionsFields =
        capabilityFields.includes("supportsImages") ||
        capabilityFields.includes("supportsPromptCache") ||
        capabilityFields.includes("supportsTools") ||
        capabilityFields.includes("hostedWebSearch") ||
        capabilityFields.includes("hostedWebFetch") ||
        capabilityFields.includes("supportsBrowserAction") ||
        capabilityFields.includes("temperature")
    const hasCapabilityFields =
        capabilityFields.includes("contextWindow") ||
        capabilityFields.includes("maxTokens") ||
        capabilityFields.includes("contextWindowTiers")
    const hasPricingFields = pricingFields.length > 0
    const hasBasePricingFields = pricingFields.includes("inputPrice") || pricingFields.includes("outputPrice")
    const hasCachePricingFields =
        supportsPromptCache && (pricingFields.includes("cacheWritesPrice") || pricingFields.includes("cacheReadsPrice"))
    const defaultContextWindow = defaults?.capabilities?.contextWindow ?? BUILT_IN_CONTEXT_WINDOW
    const defaultMaxTokens = defaults?.capabilities?.maxTokens ?? BUILT_IN_MAX_TOKENS
    // A limit may only be shown as a value when somebody actually declared it:
    // the profile selection, the profile override, or the registry catalog. The
    // built-in fallback stays out of the value chain because a real model whose
    // limit is unpublished would otherwise read 128k, look exactly like a
    // published 128k window, and make compaction trust a number nobody stated.
    // The built-in size is offered in the placeholder only.
    const declaredContextWindow =
        selectedContextWindowValue ?? capabilities.contextWindow ?? defaults?.capabilities?.contextWindow
    const declaredMaxTokens = capabilities.maxTokens ?? defaults?.capabilities?.maxTokens
    const contextWindowValue = declaredContextWindow === undefined ? "" : String(declaredContextWindow)
    const maxTokensValue = declaredMaxTokens === undefined ? "" : String(declaredMaxTokens)
    const contextTiers = draftContextTiers
    const pricingBands = draftPricingBands

    return (
        <ProfileDisclosure title="Model Configuration">
            {hasOptionsFields ? (
                <ProfileSection>
                    <ProfileSectionTitle className="text-xs uppercase tracking-wide text-description">
                        Options
                    </ProfileSectionTitle>
                    <div className="flex flex-col gap-1.5 text-sm">
                        {capabilityFields.includes("supportsImages") ? (
                            <VSCodeCheckbox
                                checked={supportsImages}
                                onChange={(e: Event | React.FormEvent<HTMLElement>) =>
                                    updateCheck("supportsImages", (e.target as HTMLInputElement | null)?.checked === true)
                                }>
                                Supports Images
                            </VSCodeCheckbox>
                        ) : null}
                        {capabilityFields.includes("hostedWebSearch") ? (
                            <VSCodeCheckbox
                                checked={modelDeclaresHostedWebSearch && hostedWebSearchEnabled}
                                disabled={!modelDeclaresHostedWebSearch}
                                onChange={(e: Event | React.FormEvent<HTMLElement>) =>
                                    updateHostedToolCheck(
                                        "hostedWebSearchEnabled",
                                        (e.target as HTMLInputElement | null)?.checked === true,
                                    )
                                }>
                                {modelDeclaresHostedWebSearch
                                    ? "Use hosted Web Search"
                                    : "Use hosted Web Search (not offered by this model)"}
                            </VSCodeCheckbox>
                        ) : null}
                        {capabilityFields.includes("hostedWebFetch") ? (
                            <VSCodeCheckbox
                                checked={modelDeclaresHostedWebFetch && hostedWebFetchEnabled}
                                disabled={!modelDeclaresHostedWebFetch}
                                onChange={(e: Event | React.FormEvent<HTMLElement>) =>
                                    updateHostedToolCheck(
                                        "hostedWebFetchEnabled",
                                        (e.target as HTMLInputElement | null)?.checked === true,
                                    )
                                }>
                                {modelDeclaresHostedWebFetch
                                    ? "Use hosted Web Fetch"
                                    : "Use hosted Web Fetch (not offered by this model)"}
                            </VSCodeCheckbox>
                        ) : null}
                        {capabilityFields.includes("supportsBrowserAction") ? (
                            <VSCodeCheckbox
                                checked={supportsBrowserAction}
                                onChange={(e: Event | React.FormEvent<HTMLElement>) =>
                                    updateCheck("supportsBrowserAction", (e.target as HTMLInputElement | null)?.checked === true)
                                }>
                                Supports Browser Actions
                            </VSCodeCheckbox>
                        ) : null}
                        {capabilityFields.includes("supportsPromptCache") ? (
                            <VSCodeCheckbox
                                checked={supportsPromptCache}
                                onChange={(e: Event | React.FormEvent<HTMLElement>) =>
                                    updateCheck("supportsPromptCache", (e.target as HTMLInputElement | null)?.checked === true)
                                }>
                                Supports Prompt Cache
                            </VSCodeCheckbox>
                        ) : null}
                        {capabilityFields.includes("supportsTools") ? (
                            <VSCodeCheckbox
                                checked={supportsTools}
                                onChange={(e: Event | React.FormEvent<HTMLElement>) =>
                                    updateCheck("supportsTools", (e.target as HTMLInputElement | null)?.checked === true)
                                }>
                                Supports Native Tool Calls
                            </VSCodeCheckbox>
                        ) : null}
                    </div>
                    {capabilityFields.includes("temperature") ? (
                        <ProfileField htmlFor={temperatureId} label="Temperature">
                            <DebouncedTextField
                                ariaLabel="Temperature"
                                className={fieldControlClass}
                                id={temperatureId}
                                initialValue={temperature != null ? String(temperature) : ""}
                                onChange={(value) => updateTemperature(parsePrice(value, 0))}
                                placeholder={
                                    defaults?.capabilities?.temperature != null
                                        ? String(defaults.capabilities.temperature)
                                        : defaults?.temperature != null
                                          ? String(defaults.temperature)
                                          : ""
                                }
                            />
                        </ProfileField>
                    ) : null}
                </ProfileSection>
            ) : null}

            {hasCapabilityFields ? (
                <ProfileSection>
                    <ProfileSectionTitle className="text-xs uppercase tracking-wide text-description">
                        Capabilities
                    </ProfileSectionTitle>
                    <ProfileInlineGrid>
                        {capabilityFields.includes("contextWindow") ? (
                            <ProfileField htmlFor={contextWindowId} label="Context Window Size">
                                <DebouncedTextField
                                    ariaLabel="Context Window Size"
                                    className={fieldControlClass}
                                    id={contextWindowId}
                                    initialValue={contextWindowValue}
                                    onChange={(value) =>
                                        onContextWindowUpdate
                                            ? onContextWindowUpdate(Number(value) || 0)
                                            : updateCapability("contextWindow", Number(value) || 0)
                                    }
                                    placeholder={`Unknown (for example ${defaultContextWindow.toLocaleString()})`}
                                />
                            </ProfileField>
                        ) : null}
                        {capabilityFields.includes("maxTokens") ? (
                            <ProfileField htmlFor={maxTokensId} label="Max Output Tokens">
                                <DebouncedTextField
                                    ariaLabel="Max Output Tokens"
                                    className={fieldControlClass}
                                    id={maxTokensId}
                                    initialValue={maxTokensValue}
                                    onChange={(value) => updateCapability("maxTokens", Number(value) || 0)}
                                    placeholder={`Unknown (for example ${defaultMaxTokens.toLocaleString()})`}
                                />
                            </ProfileField>
                        ) : null}
                    </ProfileInlineGrid>
                    {capabilityFields.includes("contextWindowTiers") ? (
                        <ContextTierEditor editable={tiersEditable} onChange={updateContextTiers} tiers={contextTiers} />
                    ) : null}
                </ProfileSection>
            ) : null}

            {hasPricingFields ? (
                <ProfileSection>
                    <ProfileSectionTitle className="text-xs uppercase tracking-wide text-description">
                        Pricing
                    </ProfileSectionTitle>
                    <ProfileField htmlFor={pricingShapeId} label="Pricing Mode">
                        <Select onValueChange={(value) => updatePricingShape(value as PricingShapeKind)} value={pricingShape}>
                            <SelectTrigger className={fieldControlClass} id={pricingShapeId}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="flat">Flat rate</SelectItem>
                                <SelectItem value="contextWindow">By context size</SelectItem>
                                <SelectItem value="timeOfDay">By time of day</SelectItem>
                            </SelectContent>
                        </Select>
                    </ProfileField>
                    <ProfileField htmlFor={currencyId} label="Currency">
                        <Select onValueChange={updateCurrency} value={currency}>
                            <SelectTrigger className={fieldControlClass} id={currencyId}>
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                {SUPPORTED_CURRENCY_CODES.map((code) => (
                                    <SelectItem key={code} value={code}>
                                        {`${code} (${getCurrencySymbol(code)})`}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </ProfileField>

                    {hasBasePricingFields && pricingShape === "timeOfDay" ? (
                        <ProfileInlineGrid>
                            <ProfileField htmlFor={`${inputPriceId}-default`} label={`Default Input (${currencySymbol}/1M)`}>
                                <DebouncedTextField
                                    ariaLabel={`Default Input (${currencySymbol}/1M)`}
                                    className={fieldControlClass}
                                    id={`${inputPriceId}-default`}
                                    initialValue={String(defaultRate.inputPrice)}
                                    onChange={(value) => updateTimeOfDayDefault("inputPrice", parsePrice(value, 0))}
                                />
                            </ProfileField>
                            <ProfileField htmlFor={`${outputPriceId}-default`} label={`Default Output (${currencySymbol}/1M)`}>
                                <DebouncedTextField
                                    ariaLabel={`Default Output (${currencySymbol}/1M)`}
                                    className={fieldControlClass}
                                    id={`${outputPriceId}-default`}
                                    initialValue={String(defaultRate.outputPrice)}
                                    onChange={(value) => updateTimeOfDayDefault("outputPrice", parsePrice(value, 0))}
                                />
                            </ProfileField>
                            {pricingFields.includes("cacheWritesPrice") ? (
                                <ProfileField
                                    htmlFor={`${cacheWritesPriceId}-default`}
                                    label={`Default Cache Writes (${currencySymbol}/1M)`}>
                                    <DebouncedTextField
                                        ariaLabel={`Default Cache Writes (${currencySymbol}/1M)`}
                                        className={fieldControlClass}
                                        id={`${cacheWritesPriceId}-default`}
                                        initialValue={String(defaultRate.cacheWritePrice)}
                                        onChange={(value) => updateTimeOfDayDefault("cacheWritePrice", parsePrice(value, 0))}
                                    />
                                </ProfileField>
                            ) : null}
                            {pricingFields.includes("cacheReadsPrice") ? (
                                <ProfileField
                                    htmlFor={`${cacheReadsPriceId}-default`}
                                    label={`Default Cache Reads (${currencySymbol}/1M)`}>
                                    <DebouncedTextField
                                        ariaLabel={`Default Cache Reads (${currencySymbol}/1M)`}
                                        className={fieldControlClass}
                                        id={`${cacheReadsPriceId}-default`}
                                        initialValue={String(defaultRate.cacheReadPrice)}
                                        onChange={(value) => updateTimeOfDayDefault("cacheReadPrice", parsePrice(value, 0))}
                                    />
                                </ProfileField>
                            ) : null}
                        </ProfileInlineGrid>
                    ) : null}

                    {pricingFields.includes("pricingTiers") && pricingShape === "timeOfDay" ? (
                        <TimeWindowEditor
                            currencySymbol={currencySymbol}
                            editable={tiersEditable}
                            onChange={updateTimeWindows}
                            showCachePrices={supportsPromptCache}
                            timezoneOffsetMinutes={timeOfDay?.schedule?.timezoneOffsetMinutes ?? 0}
                            windows={timeWindows}
                        />
                    ) : null}

                    {hasBasePricingFields && pricingShape !== "timeOfDay" ? (
                        <ProfileInlineGrid>
                            {pricingFields.includes("inputPrice") ? (
                                <ProfileField htmlFor={inputPriceId} label={`Input Price (${currencySymbol}/1M tokens)`}>
                                    <DebouncedTextField
                                        ariaLabel={`Input Price (${currencySymbol}/1M tokens)`}
                                        className={fieldControlClass}
                                        id={inputPriceId}
                                        initialValue={inputPriceValue != null ? String(inputPriceValue) : ""}
                                        onChange={(value) => updateFlatPrice("inputPrice", parsePrice(value, 0))}
                                        placeholder={defaultPrices.inputPrice ? String(defaultPrices.inputPrice) : ""}
                                    />
                                </ProfileField>
                            ) : null}
                            {pricingFields.includes("outputPrice") ? (
                                <ProfileField htmlFor={outputPriceId} label={`Output Price (${currencySymbol}/1M tokens)`}>
                                    <DebouncedTextField
                                        ariaLabel={`Output Price (${currencySymbol}/1M tokens)`}
                                        className={fieldControlClass}
                                        id={outputPriceId}
                                        initialValue={outputPriceValue != null ? String(outputPriceValue) : ""}
                                        onChange={(value) => updateFlatPrice("outputPrice", parsePrice(value, 0))}
                                        placeholder={defaultPrices.outputPrice ? String(defaultPrices.outputPrice) : ""}
                                    />
                                </ProfileField>
                            ) : null}
                        </ProfileInlineGrid>
                    ) : null}

                    {hasCachePricingFields ? (
                        <ProfileInlineGrid>
                            {pricingFields.includes("cacheWritesPrice") ? (
                                <ProfileField htmlFor={cacheWritesPriceId} label={`Cache Writes (${currencySymbol}/M)`}>
                                    <DebouncedTextField
                                        ariaLabel={`Cache Writes (${currencySymbol}/M)`}
                                        className={fieldControlClass}
                                        id={cacheWritesPriceId}
                                        initialValue={cacheWritesPriceValue != null ? String(cacheWritesPriceValue) : ""}
                                        onChange={(value) => updateFlatPrice("cacheWritePrice", parsePrice(value, 0))}
                                        placeholder={defaultPrices.cacheWritePrice ? String(defaultPrices.cacheWritePrice) : ""}
                                    />
                                </ProfileField>
                            ) : null}
                            {pricingFields.includes("cacheReadsPrice") ? (
                                <ProfileField htmlFor={cacheReadsPriceId} label={`Cache Reads (${currencySymbol}/M)`}>
                                    <DebouncedTextField
                                        ariaLabel={`Cache Reads (${currencySymbol}/M)`}
                                        className={fieldControlClass}
                                        id={cacheReadsPriceId}
                                        initialValue={cacheReadsPriceValue != null ? String(cacheReadsPriceValue) : ""}
                                        onChange={(value) => updateFlatPrice("cacheReadPrice", parsePrice(value, 0))}
                                        placeholder={defaultPrices.cacheReadPrice ? String(defaultPrices.cacheReadPrice) : ""}
                                    />
                                </ProfileField>
                            ) : null}
                        </ProfileInlineGrid>
                    ) : null}

                    {pricingFields.includes("pricingTiers") && pricingShape === "contextWindow" ? (
                        <PricingTierEditor
                            currencySymbol={currencySymbol}
                            editable={tiersEditable}
                            onChange={updatePricingBands}
                            showCachePrices={supportsPromptCache}
                            tiers={pricingBands}
                        />
                    ) : null}
                </ProfileSection>
            ) : null}
        </ProfileDisclosure>
    )
}
