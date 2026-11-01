/**
 * OpenCode `GET https://opencode.ai/inference/v1/models`.
 *
 * The gateway publishes its whole catalog — model ids, limits, capabilities,
 * prices and the API family each model is served on — to an unauthenticated
 * listing, so this source is the authority for everything the catalog carries.
 * Hand-written tables drifted from the live listing, which is what made this
 * source necessary.
 *
 * Wire protocols are derived from the listing's `api` map rather than declared
 * per model. The map names one protocol per model, but the protocol is only the
 * family's entry name: `chat-completions` and `responses` both point at
 * `…/inference/openai/v1`, and one OpenAI-compatible base serves both. Mapping
 * the base URL therefore yields the real choice, while mapping the protocol name
 * alone would under-report the protocols an OpenAI-family model accepts.
 *
 * Two facts the listing cannot state stay with the provider definitions: which
 * models a subscription plan covers, and which model is the default. Both live
 * in `openCodeCatalogDeclaration()`.
 *
 * The Console and Go plans share this one listing: a Go catalog is the same
 * models filtered by plan coverage, not a second fetch.
 */

import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import type { ModelCapabilities, ModelInfo } from "@shared/providers/types"
import { openCodeCatalogDeclaration } from "@/core/api/providers/models/opencode"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readPositiveNumber, readString } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

/** Listing root, and the root every family base URL hangs off. */
export const OPENCODE_BASE_URL = "https://opencode.ai/inference"

/**
 * The listing quotes per-million-token amounts (`cost.text.input.price`), which
 * is already the unit the catalog stores. Scaling it again would overstate every
 * price by a factor of one million.
 */

/**
 * Protocols each API family serves, keyed by the family path the listing points
 * at.
 *
 * `openai/v1` is one OpenAI-compatible base: Chat Completions and Responses are
 * two paths under it, so a model listed with either name accepts both. Gemini is
 * absent because this build carries no tool-schema path for it; such a model is
 * skipped instead of being offered with a protocol that cannot carry tools.
 */
const FAMILY_FORMATS: Readonly<Record<string, readonly ApiFormat[]>> = {
    "openai/v1": [ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES],
    "anthropic/v1": [ApiFormat.ANTHROPIC_CHAT],
}

/** Read a published per-million-token price. */
function readMillionPrice(source: unknown, ...paths: string[]): number | undefined {
    return readPositiveNumber(source, ...paths)
}

/** True when the listing marks a capability as supported. */
function capabilitySupported(source: unknown, key: string): boolean | undefined {
    if (!isRecord(source)) {
        return undefined
    }
    const entry = source[key]
    return isRecord(entry) && typeof entry.supported === "boolean" ? entry.supported : undefined
}

/**
 * True when the listing accepts image input for this model.
 *
 * The listing names concrete MIME types (`image/png`), not a bare `image`, so a
 * prefix check is what recognizes every image format instead of none of them.
 */
function supportsImageInput(source: unknown): boolean {
    if (!isRecord(source) || !isRecord(source.modalities)) {
        return false
    }
    const input = source.modalities.input
    return Array.isArray(input) && input.some((value) => typeof value === "string" && value.startsWith("image/"))
}

/**
 * The API family path a model is served on.
 *
 * The listing states one protocol per model and every entry in that protocol
 * points at the same family base, so the first base URL decides the family.
 */
function readFamilyPath(raw: unknown): string | undefined {
    if (!isRecord(raw) || !isRecord(raw.api)) {
        return undefined
    }
    for (const protocol of Object.values(raw.api)) {
        if (!isRecord(protocol)) {
            continue
        }
        const baseUrl = readString(protocol, "base_url")
        if (!baseUrl) {
            continue
        }
        // Keep the family path relative to the gateway root.
        return baseUrl.startsWith(`${OPENCODE_BASE_URL}/`) ? baseUrl.slice(OPENCODE_BASE_URL.length + 1) : undefined
    }
    return undefined
}

/** Protocols this build can carry for the model, or undefined when it carries none. */
function readApiFormats(raw: unknown): readonly ApiFormat[] | undefined {
    const family = readFamilyPath(raw)
    return family ? FAMILY_FORMATS[family] : undefined
}

export class OpenCodeModelSource extends ModelListingSource {
    readonly providerId = "opencode"
    readonly providerName = "OpenCode"
    /** The listing answers without a key, so discovery works before a Profile is saved. */
    override readonly requiresApiKey = false
    /** The catalog is fully derived from the listing, so entries that disappear should too. */
    override readonly reconciliation: ProviderModelReconciliationMode = "replace"
    protected override readonly defaultBaseUrl = OPENCODE_BASE_URL

    /**
     * The catalog always lives at the gateway root.
     *
     * A Profile may carry a `baseUrl` override pointing at a protocol root
     * (`…/inference/openai/v1`), so joining onto it would ask the wrong path.
     */
    protected override buildListingUrl(_context: ProviderRemoteContext): string {
        return `${OPENCODE_BASE_URL}/v1/models`
    }

    /**
     * Keep only models this build can actually call.
     *
     * A model whose family this build has no front end for would appear in the
     * picker and then fail on its first request, which is worse than an absent
     * entry.
     */
    protected override isChatModel(raw: unknown): boolean {
        return super.isChatModel(raw) && readApiFormats(raw) !== undefined
    }

    protected override readModelName(raw: unknown, modelId: string): string {
        return readString(raw, "name") ?? modelId
    }

    protected override readDescription(raw: unknown): string | undefined {
        return readString(raw, "description")
    }

    /** The listing publishes the context and output limits under `limit`. */
    protected override readContextWindow(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "limit.context")
    }

    protected override readMaxTokens(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "limit.output")
    }

    /**
     * Build one catalog entry.
     *
     * Limits, capabilities, prices and the accepted protocols all come from the
     * listing. Only the facts a plan decides — its coverage, its pricing mode and
     * the default — come from the declaration.
     */
    protected override toModelInfo(raw: unknown, modelId: string): ModelInfo {
        const declaration = openCodeCatalogDeclaration(modelId)
        const pricing = this.readPricing(raw)
        const apiFormats = readApiFormats(raw)
        return {
            id: modelId,
            name: this.readModelName(raw, modelId),
            description: this.readDescription(raw),
            ...(apiFormats ? { apiFormats: [...apiFormats] } : {}),
            capabilities: {
                ...this.readCapabilities(raw),
                ...(declaration?.tools ? { tools: [...declaration.tools] } : {}),
                ...(declaration?.thinking ? { thinking: declaration.thinking } : {}),
            },
            ...(pricing ? { pricing } : {}),
        }
    }

    protected override readCapabilities(raw: unknown): ModelCapabilities {
        const base = super.readCapabilities(raw)
        const capabilities = isRecord(raw) ? raw.capabilities : undefined
        return {
            ...base,
            supportsImages: supportsImageInput(raw),
            supportsTools: capabilitySupported(capabilities, "tools") ?? base.supportsTools,
            supportsReasoning: capabilitySupported(capabilities, "reasoning") ?? base.supportsReasoning,
            supportsPromptCache: this.supportsCachePricing(raw),
        }
    }

    /**
     * Whether the listing says this model caches.
     *
     * The listing states caching explicitly under `capabilities.cache`, as an
     * `explicit` or `implicit` mode, and free models publish a public price of
     * zero. A price therefore cannot stand in for the flag.
     */
    private supportsCachePricing(raw: unknown): boolean {
        const cache = isRecord(raw) && isRecord(raw.capabilities) ? raw.capabilities.cache : undefined
        return isRecord(cache)
    }

    /** The listing quotes input, output and cache rates per token. */
    protected override readPricing(raw: unknown) {
        const inputPrice = readMillionPrice(raw, "cost.text.input.price")
        const outputPrice = readMillionPrice(raw, "cost.text.output.price")
        if (inputPrice === undefined && outputPrice === undefined) {
            return undefined
        }
        return flatMeteredPricing(
            inputPrice ?? 0,
            outputPrice ?? 0,
            readMillionPrice(raw, "cost.text.input.cache.write"),
            readMillionPrice(raw, "cost.text.input.cache.read"),
        )
    }
}

export const openCodeModelSource = new OpenCodeModelSource()
