import type { ModelInfo } from "@shared/proto/dline/models"
import { type ModelCapabilities, type ModelPricing, ServerTool } from "@shared/proto/dline/models/metadata"
import { declaredServerTools, isServerToolEnabled, withServerToolSwitch } from "@shared/providers/server-tool-switches"
import { VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"
import { useEffect, useId, useState } from "react"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ProfileDisclosure, ProfileField, ProfileInlineGrid, ProfileSection, ProfileSectionTitle } from "../profile-ui"
import { DebouncedTextField } from "./DebouncedTextField"
import { ContextTierEditor, PricingTierEditor } from "./ModelTierEditor"

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
	const inputPriceId = `${fieldId}-input-price`
	const outputPriceId = `${fieldId}-output-price`
	const cacheWritesPriceId = `${fieldId}-cache-writes-price`
	const cacheReadsPriceId = `${fieldId}-cache-reads-price`
	const [draftChecks, setDraftChecks] = useState<Partial<Record<CapabilityCheckField, boolean>>>({})
	const [pendingChecks, setPendingChecks] = useState<Partial<Record<CapabilityCheckField, boolean>>>({})
	// Show registry defaults until the user edits them; edits persist as provider overrides.
	const [draftContextTiers, setDraftContextTiers] = useState(
		capabilityOverrides?.contextWindowTiers ?? defaults?.capabilities?.contextWindowTiers ?? [],
	)
	const [draftPricingTiers, setDraftPricingTiers] = useState(
		pricingTiersEnabled ? (pricingOverrides?.tiers ?? []) : (pricingOverrides?.tiers ?? defaults?.pricing?.tiers ?? []),
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
		setDraftPricingTiers(
			pricingTiersEnabled ? (pricingOverrides?.tiers ?? []) : (pricingOverrides?.tiers ?? defaults?.pricing?.tiers ?? []),
		)
	}, [pricingOverrides?.tiers, defaults?.pricing?.tiers, pricingTiersEnabled])

	// Derive currency symbol from pricing.currency
	const currencySymbol = (() => {
		const c = pricing.currency || "USD"
		const map: Record<string, string> = {
			USD: "$",
			CNY: "¥",
			EUR: "€",
			GBP: "£",
		}
		return map[c] || "$"
	})()

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

	// Update pricing field
	const updatePricing = (field: keyof ModelPricing, value: ModelPricing[keyof ModelPricing]) => {
		onPricingUpdate({ [field]: value } as Partial<ModelPricing>)
	}

	/** Persist pricing tier changes while keeping the editor responsive before profile echo. */
	const updatePricingTiers = (tiers: ModelPricing["tiers"]) => {
		const nextTiers = tiers ?? []
		setDraftPricingTiers(nextTiers)
		updatePricing("tiers", nextTiers)
	}

	// Update currency (part of pricing)
	const updateCurrency = (currency: string) => {
		onPricingUpdate({ currency })
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
	const contextWindowValue = selectedContextWindowValue ?? capabilities.contextWindow ?? defaultContextWindow
	const maxTokensValue = capabilities.maxTokens ?? defaultMaxTokens
	const contextTiers = draftContextTiers
	const pricingTiers = draftPricingTiers

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
									initialValue={String(contextWindowValue)}
									onChange={(value) =>
										onContextWindowUpdate
											? onContextWindowUpdate(Number(value) || 0)
											: updateCapability("contextWindow", Number(value) || 0)
									}
									placeholder={String(defaultContextWindow)}
								/>
							</ProfileField>
						) : null}
						{capabilityFields.includes("maxTokens") ? (
							<ProfileField htmlFor={maxTokensId} label="Max Output Tokens">
								<DebouncedTextField
									ariaLabel="Max Output Tokens"
									className={fieldControlClass}
									id={maxTokensId}
									initialValue={String(maxTokensValue)}
									onChange={(value) => updateCapability("maxTokens", Number(value) || 0)}
									placeholder={String(defaultMaxTokens)}
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
					<ProfileField htmlFor={currencyId} label="Currency">
						<Select onValueChange={updateCurrency} value={pricing.currency || "USD"}>
							<SelectTrigger className={fieldControlClass} id={currencyId}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="USD">USD ($)</SelectItem>
								<SelectItem value="CNY">CNY (¥)</SelectItem>
								<SelectItem value="EUR">EUR (€)</SelectItem>
								<SelectItem value="GBP">GBP (£)</SelectItem>
							</SelectContent>
						</Select>
					</ProfileField>

					{hasBasePricingFields ? (
						<ProfileInlineGrid>
							{pricingFields.includes("inputPrice") ? (
								<ProfileField htmlFor={inputPriceId} label={`Input Price (${currencySymbol}/1M tokens)`}>
									<DebouncedTextField
										ariaLabel={`Input Price (${currencySymbol}/1M tokens)`}
										className={fieldControlClass}
										id={inputPriceId}
										initialValue={pricing.inputPrice != null ? String(pricing.inputPrice) : ""}
										onChange={(value) => updatePricing("inputPrice", parsePrice(value, 0))}
										placeholder={
											defaults?.pricing?.inputPrice != null ? String(defaults.pricing.inputPrice) : ""
										}
									/>
								</ProfileField>
							) : null}
							{pricingFields.includes("outputPrice") ? (
								<ProfileField htmlFor={outputPriceId} label={`Output Price (${currencySymbol}/1M tokens)`}>
									<DebouncedTextField
										ariaLabel={`Output Price (${currencySymbol}/1M tokens)`}
										className={fieldControlClass}
										id={outputPriceId}
										initialValue={pricing.outputPrice != null ? String(pricing.outputPrice) : ""}
										onChange={(value) => updatePricing("outputPrice", parsePrice(value, 0))}
										placeholder={
											defaults?.pricing?.outputPrice != null ? String(defaults.pricing.outputPrice) : ""
										}
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
										initialValue={pricing.cacheWritesPrice != null ? String(pricing.cacheWritesPrice) : ""}
										onChange={(value) => updatePricing("cacheWritesPrice", parsePrice(value, 0))}
										placeholder={
											defaults?.pricing?.cacheWritesPrice != null
												? String(defaults.pricing.cacheWritesPrice)
												: ""
										}
									/>
								</ProfileField>
							) : null}
							{pricingFields.includes("cacheReadsPrice") ? (
								<ProfileField htmlFor={cacheReadsPriceId} label={`Cache Reads (${currencySymbol}/M)`}>
									<DebouncedTextField
										ariaLabel={`Cache Reads (${currencySymbol}/M)`}
										className={fieldControlClass}
										id={cacheReadsPriceId}
										initialValue={pricing.cacheReadsPrice != null ? String(pricing.cacheReadsPrice) : ""}
										onChange={(value) => updatePricing("cacheReadsPrice", parsePrice(value, 0))}
										placeholder={
											defaults?.pricing?.cacheReadsPrice != null
												? String(defaults.pricing.cacheReadsPrice)
												: ""
										}
									/>
								</ProfileField>
							) : null}
						</ProfileInlineGrid>
					) : null}

					{pricingFields.includes("pricingTiers") ? (
						<PricingTierEditor
							currencySymbol={currencySymbol}
							editable={tiersEditable}
							onChange={updatePricingTiers}
							showCachePrices={supportsPromptCache}
							tiers={pricingTiers}
						/>
					) : null}
				</ProfileSection>
			) : null}
		</ProfileDisclosure>
	)
}
