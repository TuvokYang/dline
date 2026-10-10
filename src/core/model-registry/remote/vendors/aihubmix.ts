/**
 * AIhubmix `GET /call/mdl_info_platform?tag=coding`.
 *
 * The catalog is fully published by the listing — ids, limits, capabilities and
 * prices — so it replaces the stored catalog. Prices arrive already per million
 * tokens, unlike the vendors that publish a per-token rate.
 */
import type { ModelCapabilities, ModelPricing } from "@shared/proto/dline/models/metadata"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readPositiveNumber, readString } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

/** AIhubmix omits limits for some models; these keep a usable entry. */
const ASSUMED_MAX_TOKENS = 8192
const ASSUMED_CONTEXT_WINDOW = 128_000

/** Modality and feature names that mean the model accepts images. */
const IMAGE_MARKERS = ["vision", "image"]

export class AiHubMixModelSource extends ModelListingSource {
    readonly providerId = "aihubmix"
    readonly providerName = "AIhubmix"
    override readonly requiresApiKey = false
    override readonly reconciliation: ProviderModelReconciliationMode = "replace"
    protected override readonly defaultBaseUrl = "https://aihubmix.com"

    protected override buildListingUrl(context: ProviderRemoteContext): string {
        const baseUrl = (context.baseUrl || this.defaultBaseUrl).replace(/\/+$/, "")
        return `${baseUrl}/call/mdl_info_platform?tag=coding`
    }

    /** AIhubmix wraps the array in `{ success, data }` rather than `{ data }` alone. */
    protected override readPageEntries(payload: unknown): unknown[] {
        if (!isRecord(payload) || payload.success !== true || !Array.isArray(payload.data)) {
            return []
        }
        return payload.data
    }

    protected override readModelId(raw: unknown): string | undefined {
        return readString(raw, "model")
    }

    protected override readContextWindow(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "context_window") ?? ASSUMED_CONTEXT_WINDOW
    }

    protected override readMaxTokens(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "max_output") ?? ASSUMED_MAX_TOKENS
    }

    protected override readDescription(raw: unknown): string {
        return readString(raw, "desc_en", "desc") ?? ""
    }

    protected override readCapabilities(raw: unknown): ModelCapabilities {
        return {
            contextWindow: this.readContextWindow(raw),
            maxTokens: this.readMaxTokens(raw),
            supportsImages: supportsImageInput(raw),
            supportsPromptCache: supportsPromptCache(raw),
            supportsReasoning: hasFeature(raw, "thinking"),
        }
    }

    /** Prices are already per million tokens, so they pass through unscaled. */
    protected override readPricing(raw: unknown): ModelPricing {
        return {
            inputPrice: readPositiveNumber(raw, "pricing.input") ?? 0,
            outputPrice: readPositiveNumber(raw, "pricing.output") ?? 0,
            cacheWritesPrice: readPositiveNumber(raw, "pricing.cache_write") ?? 0,
            cacheReadsPrice: readPositiveNumber(raw, "pricing.cache_read") ?? 0,
        }
    }
}

function readStringArray(raw: unknown, field: string): string[] {
    if (!isRecord(raw) || !Array.isArray(raw[field])) {
        return []
    }
    return (raw[field] as unknown[]).filter((entry): entry is string => typeof entry === "string")
}

function hasFeature(raw: unknown, feature: string): boolean {
    return readStringArray(raw, "features").includes(feature)
}

function supportsImageInput(raw: unknown): boolean {
    const advertised = [...readStringArray(raw, "modalities"), ...readStringArray(raw, "features")]
    return IMAGE_MARKERS.some((marker) => advertised.includes(marker))
}

/**
 * AIhubmix does not publish a cache flag. A cache ratio other than 1, or a read
 * price that undercuts the input price, is what marks a cache-capable model.
 */
function supportsPromptCache(raw: unknown): boolean {
    if (!isRecord(raw)) {
        return false
    }
    const cacheRatio = raw.cache_ratio
    if (typeof cacheRatio === "number" && cacheRatio !== 1) {
        return true
    }
    const pricing = raw.pricing
    if (!isRecord(pricing)) {
        return false
    }
    const cacheRead = pricing.cache_read
    const input = pricing.input
    return typeof cacheRead === "number" && typeof input === "number" && cacheRead !== input
}

export const aiHubMixModelSource = new AiHubMixModelSource()
