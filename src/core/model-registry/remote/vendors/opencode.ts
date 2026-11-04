/**
 * OpenCode model listings: Console at `GET https://opencode.ai/inference/v1/models`,
 * Go at `GET https://opencode.ai/inference/go/v1/models`.
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
 * No model fact is declared locally. Every field a Profile acts on — limits,
 * cache flag, reasoning levels, input modalities, protocols and prices — is read
 * from the listing below; a hand-written description of a model would be a claim
 * the gateway never made.
 *
 * Each plan publishes its own listing. Console serves `/inference/v1/models`
 * and Go serves `/inference/go/v1/models`, so the catalog key a discovery asks
 * for decides which one is read; an entry present in one plan is not evidence
 * that the other plan serves it.
 */

import { ApiFormat, type ContextWindowBand, type ThinkingConfig } from "@shared/proto/dline/models/metadata"
import { flatMeteredPricing, withBands } from "@shared/providers/pricing-shape"
import { OPENCODE_GO_CATALOG } from "@shared/providers/provider-catalog-key"
import type { ModelCapabilities, ModelInfo } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readNonNegativeNumber, readPositiveNumber, readString } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

/** Gateway root: the Console listing root and the prefix every family base URL hangs off. */
export const OPENCODE_BASE_URL = "https://opencode.ai/inference"

/** The Go plan publishes its catalog and families under this segment. */
const OPENCODE_GO_ROOT = `${OPENCODE_BASE_URL}/go`

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
 * two paths under it, so a model listed with either name accepts both. Responses
 * is listed first because it is the protocol this gateway publishes as each
 * model's native entry, and the default resolver takes the first supported
 * format when a Profile has no stored choice. Gemini is absent because this
 * build carries no tool-schema path for it; such a model is skipped instead of
 * being offered with a protocol that cannot carry tools.
 */
const FAMILY_FORMATS: Readonly<Record<string, readonly ApiFormat[]>> = {
    "openai/v1": [ApiFormat.OPENAI_RESPONSES, ApiFormat.OPENAI_CHAT],
    "anthropic/v1": [ApiFormat.ANTHROPIC_CHAT],
}

/**
 * Read a published per-million-token price.
 *
 * A zero is a published rate, not a missing one: free models state `price: 0`
 * and a paid model may state a zero cache rate. Reading only positive values
 * would leave every free entry without a price set, which the usage surface
 * cannot tell apart from "the seller publishes no terms".
 */
function readMillionPrice(source: unknown, ...paths: string[]): number | undefined {
    return readNonNegativeNumber(source, ...paths)
}

/**
 * The token-tiered rates the listing publishes, or `undefined` when it bills flat.
 *
 * An override states "this rate applies once the request passes N input tokens".
 * The catalog expresses the same thing as bands, where a band's `maxInputTokens`
 * is the largest request it covers, so an override at `gt: N` ends the band that
 * holds everything up to `N` and the base rate covers that first band.
 *
 * Only the outer edges become bands: the listing publishes at most one override
 * per model today, and a band chain built from arbitrary distances would invent
 * prices for the gaps.
 */
function readPricingBands(
    source: unknown,
    inputPrice: number | undefined,
    outputPrice: number | undefined,
): ContextWindowBand[] | undefined {
    const inputOverride = firstOverride(source, "cost.text.input.overrides")
    const outputOverride = firstOverride(source, "cost.text.output.overrides")
    // Every model in the listing that tiers prices uses the same threshold on both
    // sides, so one band edge describes the entry. A future entry that tiers only
    // one side still lands here, with the other side keeping its base rate.
    const threshold = inputOverride?.threshold ?? outputOverride?.threshold
    if (threshold === undefined) {
        return undefined
    }
    const cacheRead = readNonNegativeNumber(source, "cost.text.input.cache.read")
    const cacheWrite = readNonNegativeNumber(source, "cost.text.input.cache.write")
    return [
        {
            maxInputTokens: threshold,
            prices: { inputPrice, outputPrice, cacheReadPrice: cacheRead, cacheWritePrice: cacheWrite },
        },
        {
            prices: {
                inputPrice: inputOverride?.price ?? inputPrice,
                outputPrice: outputOverride?.price ?? outputPrice,
                cacheReadPrice: inputOverride?.cacheRead ?? cacheRead,
                cacheWritePrice: inputOverride?.cacheWrite ?? cacheWrite,
            },
        },
    ]
}

/**
 * The first published override at a context threshold, or `undefined` when the
 * listing does not tier this side.
 */
function firstOverride(
    source: unknown,
    path: string,
): { threshold: number; price?: number; cacheRead?: number; cacheWrite?: number } | undefined {
    const entries = readArrayAt(source, path)
    if (!entries) {
        return undefined
    }
    for (const entry of entries) {
        if (!isRecord(entry)) {
            continue
        }
        const threshold = readNonNegativeNumber(entry, "when.context.gt")
        if (threshold === undefined || threshold <= 0) {
            continue
        }
        return {
            threshold,
            price: readNonNegativeNumber(entry, "price"),
            cacheRead: readNonNegativeNumber(entry, "cache.read"),
            cacheWrite: readNonNegativeNumber(entry, "cache.write"),
        }
    }
    return undefined
}

/** Read a nested array by dotted path, or `undefined` when any step is missing. */
function readArrayAt(source: unknown, path: string): unknown[] | undefined {
    let current: unknown = source
    for (const key of path.split(".")) {
        if (!isRecord(current)) {
            return undefined
        }
        current = current[key]
    }
    return Array.isArray(current) ? current : undefined
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
 * The input MIME types the listing declares for this model.
 *
 * The listing names concrete types (`image/png`, `application/pdf`,
 * `audio/mpeg`), not bare families, so the list is copied as published and
 * normalized later by the shared media resolver. `text` is not a media type
 * Dline negotiates, so it is dropped instead of offered as an attachment type.
 */
function readInputMediaTypes(source: unknown): string[] {
    if (!isRecord(source) || !isRecord(source.modalities)) {
        return []
    }
    const input = source.modalities.input
    if (!Array.isArray(input)) {
        return []
    }
    return input.filter((value): value is string => typeof value === "string" && value.includes("/"))
}

/**
 * The thinking declaration the listing publishes, or `undefined` when it states
 * none.
 *
 * Only facts the listing actually states are copied. `defaultEffort`,
 * `defaultEnabled` and `canDisable` are separate declarations in
 * `models/metadata.proto`, so a `supported` flag or a `toggle` flag is not
 * evidence for any of them: a model that accepts `effort` without publishing a
 * default must fall back to the provider default, and a model whose `effort`
 * list has no `none` entry is not thereby forced to keep thinking on.
 */
function readThinking(source: unknown): ThinkingConfig | undefined {
    if (!isRecord(source) || !isRecord(source.capabilities)) {
        return undefined
    }
    const reasoning = source.capabilities.reasoning
    if (!isRecord(reasoning)) {
        return undefined
    }
    const effortLevels = Array.isArray(reasoning.effort)
        ? reasoning.effort.filter((value): value is string => typeof value === "string" && value.length > 0)
        : []
    if (effortLevels.length > 0) {
        return { supported: true, mode: "effort", effortLevels }
    }
    if (isRecord(reasoning.budget)) {
        const minBudget = readPositiveNumber(reasoning, "budget.min")
        const maxBudget = readPositiveNumber(reasoning, "budget.max")
        return {
            supported: true,
            mode: "budget",
            ...(minBudget === undefined ? {} : { minBudget }),
            ...(maxBudget === undefined ? {} : { maxBudget }),
        }
    }
    return reasoning.supported === true ? { supported: true } : undefined
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
        if (!baseUrl.startsWith(`${OPENCODE_BASE_URL}/`)) {
            return undefined
        }
        // The Go endpoint publishes the same families under a `/go` segment
        // (`.../inference/go/openai/v1`). The protocol a model speaks is decided
        // by the family, not by which plan endpoint serves it, so the segment is
        // dropped before the family lookup.
        return baseUrl.slice(OPENCODE_BASE_URL.length + 1).replace(/^go\//, "")
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
    /**
     * The catalog is merged, not replaced.
     *
     * Every fact the gateway publishes is authoritative for this model, but the
     * catalog also carries what a Profile declared about a model — a manual
     * entry, a price a person corrected — and a listing that goes silent about a
     * field must not erase it. Merging keeps both: fields the vendor states win,
     * fields it omits keep their stored value.
     *
     * There is deliberately no removal branch, so a model the listing stops
     * returning stays available rather than disappearing on a listing outage.
     * Retiring a model needs an explicit decision, not an inference from absence.
     */
    override readonly reconciliation: ProviderModelReconciliationMode = "overlay-remote"
    protected override readonly defaultBaseUrl = OPENCODE_BASE_URL

    /**
     * Pick the listing that belongs to the plan being refreshed.
     *
     * Each plan publishes its own catalog: Console at `/v1/models`, Go at
     * `/go/v1/models`. Reading the Console listing for a Go catalog is what put
     * Console-only entries into the Go picker and left Go-only entries missing.
     *
     * Plan roots are fixed at the gateway, like `baseUrl` below: a Profile may
     * carry a `baseUrl` override pointing at a protocol root
     * (`…/inference/openai/v1`), so joining onto it would ask the wrong path, and
     * a caller with no catalog key gets the primary (Console) listing.
     */
    protected override buildListingUrl(context: ProviderRemoteContext): string {
        const planRoot = context.catalogKey === OPENCODE_GO_CATALOG ? OPENCODE_GO_ROOT : OPENCODE_BASE_URL
        return `${planRoot}/v1/models`
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

    /**
     * The listing publishes the input and output limits under `limit`.
     *
     * `limit.input` is the ceiling on what one request may send, which is exactly
     * what `contextWindow` means here; `limit.context` is the total the model can
     * hold and is larger when an answer is reserved inside it (`gpt-6-astra`
     * publishes 922k input inside a 1.05M context). Reading `context` alone would
     * let compaction fill a window the request cannot actually carry.
     */
    protected override readContextWindow(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "limit.input", "limit.context")
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
        const pricing = this.readPricing(raw)
        const apiFormats = readApiFormats(raw)
        const remoteThinking = readThinking(raw)
        return {
            id: modelId,
            name: this.readModelName(raw, modelId),
            description: this.readDescription(raw),
            ...(apiFormats ? { apiFormats: [...apiFormats] } : {}),
            capabilities: {
                ...this.readCapabilities(raw),
                // The thinking control is exactly what the listing states. A field
                // the listing omits stays absent so the Profile falls back to the
                // provider default, instead of locking a switch or naming an effort
                // level the gateway never published.
                ...(remoteThinking ? { thinking: remoteThinking } : {}),
            },
            ...(pricing ? { pricing } : {}),
        }
    }

    protected override readCapabilities(raw: unknown): ModelCapabilities {
        const base = super.readCapabilities(raw)
        const capabilities = isRecord(raw) ? raw.capabilities : undefined
        const inputMediaTypes = readInputMediaTypes(raw)
        return {
            ...base,
            supportsImages: inputMediaTypes.some((mediaType) => mediaType.startsWith("image/")),
            // The listing publishes the exact MIME types the model reads, so a
            // model that takes PDF but no image is described as such instead of
            // being flattened into the image-only legacy flag.
            ...(inputMediaTypes.length > 0 ? { inputMediaTypes } : {}),
            supportsTools: capabilitySupported(capabilities, "tools") ?? base.supportsTools,
            supportsReasoning: capabilitySupported(capabilities, "reasoning") ?? base.supportsReasoning,
            // Caching is a property of this gateway, not of an individual entry.
            // The listing either names a mode (`explicit`/`implicit`) or omits the
            // block entirely, and both cases mean the model caches, so the flag is
            // constant rather than derived from the presence of the block.
            supportsPromptCache: true,
        }
    }

    /** The listing quotes input, output and cache rates per token. */
    protected override readPricing(raw: unknown) {
        const inputPrice = readMillionPrice(raw, "cost.text.input.price")
        const outputPrice = readMillionPrice(raw, "cost.text.output.price")
        if (inputPrice === undefined && outputPrice === undefined) {
            return undefined
        }
        const flat = flatMeteredPricing(
            inputPrice,
            outputPrice,
            readMillionPrice(raw, "cost.text.input.cache.write"),
            readMillionPrice(raw, "cost.text.input.cache.read"),
        )
        // 14 models bill more once the request passes a context threshold. Reading
        // only the headline rate would understate them by up to five times, so the
        // published overrides become bands and the first tier keeps the base price.
        const bands = readPricingBands(raw, inputPrice, outputPrice)
        return bands ? (withBands(flat, bands) ?? flat) : flat
    }
}

export const openCodeModelSource = new OpenCodeModelSource()
