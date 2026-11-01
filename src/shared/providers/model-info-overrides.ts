import type { ModelInfo } from "@shared/proto/dline/models"
import type { ModelCapabilities, ModelPricing } from "@shared/proto/dline/models/metadata"
import { readCurrency } from "@shared/providers/pricing-shape"

export type ModelCapabilityOverrideField = "maxTokens" | "contextWindow" | "supportsImages" | "supportsPromptCache"
export type ModelPricingOverrideField = "inputPrice" | "outputPrice" | "cacheWritesPrice" | "cacheReadsPrice" | "currency"
export type ModelInfoTopLevelOverrideField = "temperature"

export interface ModelInfoOverrideFields {
    capabilities?: ModelCapabilityOverrideField[]
    pricing?: ModelPricingOverrideField[]
    other?: ModelInfoTopLevelOverrideField[]
}

interface ModelInfoOverridePolicy {
    fields: ModelInfoOverrideFields
    allowRegistryModelOverrides?: boolean
}

export const CONFIGURABLE_MODEL_INFO_FIELDS: ModelInfoOverrideFields = {
    capabilities: ["maxTokens", "contextWindow", "supportsImages", "supportsPromptCache"],
    pricing: ["inputPrice", "outputPrice", "cacheWritesPrice", "cacheReadsPrice", "currency"],
    other: ["temperature"],
}

const MODEL_INFO_OVERRIDE_POLICIES: Record<string, ModelInfoOverridePolicy> = {
    openai: {
        fields: CONFIGURABLE_MODEL_INFO_FIELDS,
        allowRegistryModelOverrides: true,
    },
    anthropic: {
        fields: {
            capabilities: ["maxTokens", "contextWindow", "supportsImages", "supportsPromptCache"],
            pricing: ["inputPrice", "outputPrice", "cacheWritesPrice", "cacheReadsPrice", "currency"],
        },
    },
}

function clone<T>(value: T): T {
    return value === undefined ? value : JSON.parse(JSON.stringify(value))
}

function isObject(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === "object" && !Array.isArray(value)
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> | undefined {
    const result: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(value)) {
        if (entry !== undefined) {
            result[key] = entry
        }
    }
    return Object.keys(result).length > 0 ? result : undefined
}

function mergeDefined(base?: Record<string, unknown>, override?: Record<string, unknown>): Record<string, unknown> | undefined {
    const result = { ...(base ?? {}) }
    for (const [key, value] of Object.entries(override ?? {})) {
        if (value !== undefined) {
            result[key] = value
        }
    }
    return compactObject(result)
}

function valuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right)
}

function hasModelInfoContent(modelInfo: Partial<ModelInfo>): boolean {
    return Object.entries(modelInfo).some(([key, value]) => key !== "id" && value !== undefined)
}

/**
 * Map a public override field name onto the slot it edits in the price set.
 *
 * The public names are the settings contract; the price set uses singular slot
 * names. Keeping the mapping here means a settings key never has to follow an
 * internal rename again.
 */
const PRICE_SET_FIELD: Record<string, "inputPrice" | "outputPrice" | "cacheWritePrice" | "cacheReadPrice"> = {
    inputPrice: "inputPrice",
    outputPrice: "outputPrice",
    cacheWritesPrice: "cacheWritePrice",
    cacheReadsPrice: "cacheReadPrice",
}

/**
 * Build the stored price override from the rates that differ from the registry.
 *
 * The override is written as a complete flat metered price so a reader never has
 * to know which subset of rates the profile happened to change. Unchanged slots
 * carry the registry value, which keeps the stored document self-describing.
 */
function buildPricingOverride(
    fields: ModelPricingOverrideField[],
    candidatePricing: ModelPricing | undefined,
    basePricing: ModelPricing | undefined,
): ModelPricing | undefined {
    const candidatePrices = candidatePricing?.metered?.strategy?.flat?.prices
    const basePrices = basePricing?.metered?.strategy?.flat?.prices
    const candidateCurrency = readCurrency(candidatePricing)
    const baseCurrency = readCurrency(basePricing)

    const changed: Record<string, number | string> = {}
    for (const field of fields) {
        if (field === "currency") {
            if (candidateCurrency !== undefined && candidateCurrency !== baseCurrency) {
                changed.currency = candidateCurrency
            }
            continue
        }
        const slot = PRICE_SET_FIELD[field]
        const candidateValue = slot ? candidatePrices?.[slot] : undefined
        if (slot && candidateValue !== undefined && candidateValue !== basePrices?.[slot]) {
            changed[slot] = candidateValue
        }
    }

    if (Object.keys(changed).length === 0) {
        return undefined
    }

    return {
        metered: {
            currency: (changed.currency as string | undefined) ?? baseCurrency ?? "USD",
            strategy: {
                flat: {
                    prices: {
                        inputPrice: (changed.inputPrice as number | undefined) ?? basePrices?.inputPrice ?? 0,
                        outputPrice: (changed.outputPrice as number | undefined) ?? basePrices?.outputPrice ?? 0,
                        cacheWritePrice: (changed.cacheWritePrice as number | undefined) ?? basePrices?.cacheWritePrice,
                        cacheReadPrice: (changed.cacheReadPrice as number | undefined) ?? basePrices?.cacheReadPrice,
                    },
                },
            },
        },
    } as ModelPricing
}

export function getModelInfoOverrideFields(provider?: string): ModelInfoOverrideFields | undefined {
    return provider ? MODEL_INFO_OVERRIDE_POLICIES[provider]?.fields : undefined
}

export function canStoreRegistryModelInfoOverrides(provider?: string): boolean {
    return provider ? MODEL_INFO_OVERRIDE_POLICIES[provider]?.allowRegistryModelOverrides === true : false
}

export function mergeModelInfo(base?: ModelInfo, override?: Partial<ModelInfo>): ModelInfo | undefined {
    if (!base && !override) {
        return undefined
    }

    const baseClone = clone(base ?? {}) as Partial<ModelInfo>
    const overrideClone = clone(override ?? {}) as Partial<ModelInfo>
    const merged: Partial<ModelInfo> = {
        ...baseClone,
        ...overrideClone,
        id: overrideClone.id || baseClone.id || "",
    }

    const capabilities = mergeDefined(
        baseClone.capabilities as Record<string, unknown> | undefined,
        overrideClone.capabilities as Record<string, unknown> | undefined,
    )
    if (capabilities) {
        merged.capabilities = capabilities as unknown as ModelCapabilities
    } else {
        delete merged.capabilities
    }

    const pricing = mergeDefined(
        baseClone.pricing as Record<string, unknown> | undefined,
        overrideClone.pricing as Record<string, unknown> | undefined,
    )
    if (pricing) {
        merged.pricing = pricing as unknown as ModelPricing
    } else {
        delete merged.pricing
    }

    return merged.id || hasModelInfoContent(merged) ? (merged as ModelInfo) : undefined
}

export function mergeModelInfoOverride(
    current: Partial<ModelInfo> | undefined,
    updates: Partial<ModelInfo> | undefined,
    modelId?: string,
): ModelInfo | undefined {
    const merged = mergeModelInfo(current as ModelInfo | undefined, updates)
    if (!merged) {
        return modelId ? ({ id: modelId } as ModelInfo) : undefined
    }
    if (modelId) {
        merged.id = modelId
    }
    return merged
}

export function pickModelInfoOverride(
    candidate: Partial<ModelInfo> | undefined,
    base: ModelInfo | undefined,
    fields: ModelInfoOverrideFields | undefined,
): Partial<ModelInfo> | undefined {
    if (!candidate) {
        return undefined
    }

    if (!base) {
        return clone(candidate)
    }

    if (!fields) {
        return undefined
    }

    const override: Partial<ModelInfo> = { id: candidate.id || base.id }

    if (fields.capabilities?.length) {
        const capabilities: Record<string, unknown> = {}
        for (const field of fields.capabilities) {
            const value = candidate.capabilities?.[field]
            if (value !== undefined && !valuesEqual(value, base.capabilities?.[field])) {
                capabilities[field] = clone(value)
            }
        }
        const compacted = compactObject(capabilities)
        if (compacted) {
            override.capabilities = compacted as unknown as ModelCapabilities
        }
    }

    if (fields.pricing?.length) {
        const overridePricing = buildPricingOverride(fields.pricing, candidate.pricing, base.pricing)
        if (overridePricing) {
            override.pricing = overridePricing
        }
    }

    for (const field of fields.other ?? []) {
        const value = candidate[field]
        if (value !== undefined && !valuesEqual(value, base[field])) {
            ;(override as Record<string, unknown>)[field] = clone(value)
        }
    }

    return hasModelInfoContent(override) ? override : undefined
}

export function modelInfoToStorageJson(modelInfo: Partial<ModelInfo> | undefined): Record<string, unknown> | undefined {
    if (!modelInfo) {
        return undefined
    }
    const json = clone(modelInfo) as Record<string, unknown>
    return isObject(json) && (json.id !== undefined || Object.keys(json).length > 0) ? json : undefined
}
