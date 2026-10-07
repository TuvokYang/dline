import type { ModelInfo } from "@shared/proto/dline/models"
import type { ContextWindowTier, ModelCapabilities, ModelPricing } from "@shared/proto/dline/models/metadata"

export interface ProviderModelOverrides {
	capabilities?: ModelCapabilities
	pricing?: ModelPricing
	enableLongContext?: boolean
	pricingTiersEnabled?: boolean
	preferContextWindowTier?: boolean
	contextWindowTiersEnabled?: boolean
}

/**
 * Merge provider override fields while dropping generated undefined values.
 *
 * @param base Existing provider override object.
 * @param updates Partial override update from the UI.
 * @returns Merged override object without undefined-valued keys.
 */
export function mergeDefined<T extends object>(base: T | undefined, updates: Partial<T>): Partial<T> {
	const baseEntries = Object.entries(base ?? {}).filter(([, value]) => value !== undefined)
	const updateEntries = Object.entries(updates).filter(([, value]) => value !== undefined)
	return Object.fromEntries([...baseEntries, ...updateEntries]) as Partial<T>
}

/**
 * Merge provider capability overrides without preserving undefined fields.
 *
 * @param base Existing provider capability overrides.
 * @param updates Partial capability updates.
 * @returns Merged capability overrides.
 */
export function mergeCapabilities(base: ModelCapabilities | undefined, updates: Partial<ModelCapabilities>): ModelCapabilities {
	const merged = mergeDefined(base, updates) as ModelCapabilities
	if (base?.thinking || updates.thinking) {
		const thinking = mergeDefined(base?.thinking, updates.thinking ?? {}) as NonNullable<ModelCapabilities["thinking"]>
		merged.thinking = {
			...thinking,
			...(thinking.effortLevels !== undefined ? { effortLevels: [...thinking.effortLevels] } : {}),
		}
	}
	return merged
}

/**
 * Merge provider pricing overrides without preserving undefined fields.
 *
 * @param base Existing provider pricing overrides.
 * @param updates Partial pricing updates.
 * @returns Merged pricing overrides.
 */
export function mergePricing(base: ModelPricing | undefined, updates: Partial<ModelPricing>): ModelPricing {
	return mergeDefined(base, updates) as ModelPricing
}

/**
 * Select the context tier represented by a provider configuration.
 *
 * @param capabilities Model capabilities containing selectable context tiers.
 * @param enableLongContext Whether the provider's long-context option is enabled.
 * @returns Selected context tier, or undefined when the model has no tiers.
 */
export function selectContextTier(
	capabilities: ModelCapabilities | undefined,
	enableLongContext: boolean | undefined,
): ContextWindowTier | undefined {
	const tiers = capabilities?.contextWindowTiers ?? []
	if (tiers.length === 0) {
		return undefined
	}

	if (enableLongContext === true) {
		return tiers.find((tier) => tier.id === "long") ?? [...tiers].sort((a, b) => b.contextWindow - a.contextWindow)[0]
	}

	return (
		tiers.find((tier) => tier.id === "standard") ??
		tiers.find((tier) => tier.contextWindow === capabilities?.contextWindow) ??
		[...tiers].sort((a, b) => a.contextWindow - b.contextWindow)[0]
	)
}

/** Update the selected context tier, or the direct window for models without tiers. */
export function updateSelectedContextWindow(
	baseCapabilities: ModelCapabilities | undefined,
	overrideCapabilities: ModelCapabilities | undefined,
	enableLongContext: boolean | undefined,
	contextWindow: number,
	contextWindowTiersEnabled = true,
): ModelCapabilities {
	if (!contextWindowTiersEnabled) {
		const { contextWindowTiers: _staleTiers, ...remainingOverrides } = overrideCapabilities ?? {}
		return { ...remainingOverrides, contextWindow } as ModelCapabilities
	}

	const tiers = overrideCapabilities?.contextWindowTiers ?? baseCapabilities?.contextWindowTiers ?? []
	if (tiers.length === 0) {
		return mergeCapabilities(overrideCapabilities, { contextWindow })
	}

	const selectedTier = selectContextTier(
		{ ...baseCapabilities, ...overrideCapabilities, contextWindowTiers: tiers },
		enableLongContext,
	)
	const { contextWindow: _legacyContextWindow, ...remainingOverrides } = overrideCapabilities ?? {}
	return {
		...remainingOverrides,
		contextWindowTiers: tiers.map((tier) =>
			tier === selectedTier || tier.id === selectedTier?.id ? { ...tier, contextWindow } : tier,
		),
	} as ModelCapabilities
}

/**
 * Drop a `tools` entry carried by provider overrides.
 *
 * `capabilities.tools` states what a model can do and is owned by the registry.
 * A profile only records the user's on/off switch, so letting an override reach
 * this merge would turn "switched off" into "this model has no such capability"
 * and delete the hosted route for good. Every consumer builds effective model
 * metadata here, so stripping once keeps handlers and UI on the same rule.
 */
function withoutServerToolDeclaration(capabilities: ModelCapabilities): ModelCapabilities {
	if (capabilities.tools === undefined) {
		return capabilities
	}
	const { tools: _profileSwitch, ...declarationFree } = capabilities
	return declarationFree as ModelCapabilities
}

/**
 * Build effective model metadata from registry metadata and provider overrides.
 *
 * @param modelId Selected model id, if any.
 * @param registryModel Model metadata loaded from provider registry.
 * @param overrides Provider-specific capability and pricing overrides.
 * @returns Effective model metadata for display and request handling.
 */
export function buildEffectiveModelInfo(
	modelId: string | undefined,
	registryModel: ModelInfo | undefined,
	overrides: ProviderModelOverrides,
): ModelInfo {
	const base: ModelInfo = registryModel ?? ({ id: modelId ?? "" } as ModelInfo)
	const capabilityOverrides = overrides.capabilities ? withoutServerToolDeclaration(overrides.capabilities) : undefined
	const mergedCapabilitiesValue = capabilityOverrides
		? mergeCapabilities(base.capabilities, capabilityOverrides)
		: base.capabilities
	const mergedCapabilities =
		overrides.contextWindowTiersEnabled === false && mergedCapabilitiesValue
			? ({ ...mergedCapabilitiesValue, contextWindowTiers: undefined } as ModelCapabilities)
			: mergedCapabilitiesValue
	const explicitContextWindow = capabilityOverrides?.contextWindow
	const contextTier =
		overrides.preferContextWindowTier === true || explicitContextWindow === undefined
			? selectContextTier(mergedCapabilities, overrides.enableLongContext)
			: undefined
	const capabilities = {
		...mergedCapabilities,
		...(contextTier ? { contextWindow: contextTier.contextWindow } : {}),
		supportsPromptCache: mergedCapabilities?.supportsPromptCache ?? true,
	} as ModelCapabilities
	const mergedPricing = overrides.pricing ? (mergeDefined(base.pricing, overrides.pricing) as ModelPricing) : base.pricing
	const overrideTiers = overrides.pricing?.tiers ?? []
	const selectedTiers = overrides.pricingTiersEnabled === true ? overrideTiers : base.pricing?.tiers
	const pricing = mergedPricing
		? ({ ...mergedPricing, ...(selectedTiers !== undefined && { tiers: selectedTiers }) } as ModelPricing)
		: selectedTiers !== undefined
			? ({ tiers: selectedTiers } as ModelPricing)
			: undefined

	return {
		...base,
		id: modelId ?? base.id ?? "",
		capabilities,
		pricing,
	}
}
