/**
 * App-layer type augmentations for provider model configuration.
 * Proto types from proto/dline/models are re-exported via @shared/api.
 * This file provides webview-safe augmentations (no proto direct references from webview).
 */
import type { ImageModelInfo, ModelInfo } from "../proto/dline/models"
import type { ImageGenerationCapabilities, ImagePricing, ModelCapabilities, ModelPricing } from "../proto/dline/models/metadata"

export type { ImageGenerationCapabilities, ImageModelInfo, ImagePricing, ModelCapabilities, ModelInfo, ModelPricing }

/**
 * App-layer ThinkingConfig — compatible with model file definitions.
 * Optional declarations retain absence through the proto conversion boundary.
 */
export interface ThinkingConfig {
    minBudget?: number
    maxBudget?: number
    supported?: boolean
    mode?: string
    effortLevels?: string[]
    defaultEnabled?: boolean
    canDisable?: boolean
    defaultEffort?: string
}

/**
 * Usage-based tiered pricing band. `contextWindow` is the maximum input-token
 * usage for this price band; it controls pricing only, not the context window.
 */
export interface PricingTier {
    contextWindow: number
    inputPrice?: number
    outputPrice?: number
    cacheWritesPrice?: number
    cacheReadsPrice?: number
}

/**
 * Selector group a provider belongs to.
 *
 * `frontier` vendors train their own flagship models, `aggregator` entries route
 * to other vendors' models, and `standard` covers everything else.
 */
export type ProviderTier = "frontier" | "aggregator" | "standard"

/**
 * One model catalog a provider serves.
 *
 * A catalog is the unit that answers "which models, and which one is the
 * default". The provider entry itself carries the primary catalog; `catalogs`
 * carries the alternatives a Profile option can select.
 */
export interface ProviderCatalog {
    models: { [key: string]: ModelInfo }
    defaultModelId?: string
    imageModels?: { [key: string]: ImageModelInfo }
    defaultImageModelId?: string
}

/** Provider model configuration, loaded from JSON. */
export interface ProviderModelsConfig {
    provider: string
    providerName: string
    /**
     * Additional catalogs this provider serves, keyed by catalog key.
     *
     * A provider exposes one selectable identity, but one Profile option may
     * switch which model set it reads: a billing mode whose plan covers other
     * models, or a regional endpoint. Those catalogs belong to the provider that
     * serves them, so the registry never has to invent a second selectable
     * provider to reach them. The key itself comes from
     * `resolveCatalogProviderKey`, which owns the option-to-key mapping.
     */
    catalogs?: Record<string, ProviderCatalog>
    /** Selector group; entries without a tier fall back to `standard`. */
    tier?: ProviderTier
    /**
     * Rank within the `frontier` group, lowest first. Only relative order matters,
     * so ranks are spaced to allow insertions without renumbering. Ignored by the
     * other groups, which sort alphabetically.
     */
    frontierRank?: number
    baseUrl?: string
    billingUrl?: string
    billingMode: string
    usageLimits?: {
        hourly?: number
        daily?: number
        weekly?: number
        monthly?: number
        unit: string
    }
    models: { [key: string]: ModelInfo }
    defaultModelId?: string
    imageModels?: { [key: string]: ImageModelInfo }
    defaultImageModelId?: string
    /**
     * Catalogs large enough that loading them would delay startup. The registry
     * loads these after the blocking pass instead of during it.
     */
    deferred?: boolean
}
