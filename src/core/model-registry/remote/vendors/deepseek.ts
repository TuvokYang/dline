/**
 * DeepSeek `GET /models`.
 *
 * The listing only reports ids (`{ object: "list", data: [{ id, object,
 * owned_by }] }`), so window and output limits come from the documented
 * platform defaults rather than the response. DeepSeek publishes no prices in
 * this endpoint, which keeps stored pricing intact.
 *
 * The listing also omits tool and reasoning support. DeepSeek serves every
 * listed model through the same native function-calling and declared-effort
 * thinking contract as the seeded catalog, so this source declares those
 * capabilities instead of leaving a discovered model less capable than a
 * seeded one.
 */
import type { ModelCapabilities, ThinkingConfig } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { ModelListingSource, readSupportedFeature } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

/** Documented platform defaults; the listing endpoint reports neither value. */
const DEEPSEEK_CONTEXT_WINDOW = 1_000_000
const DEEPSEEK_MAX_OUTPUT_TOKENS = 384_000

/** Effort levels DeepSeek accepts for a thinking request. */
const DEEPSEEK_REASONING_EFFORT_OPTIONS = ["low", "high", "max"] as const

/** Declared thinking contract for a discovered DeepSeek model. */
const DEEPSEEK_THINKING: ThinkingConfig = Object.freeze({
    supported: true,
    mode: "effort",
    effortLevels: [...DEEPSEEK_REASONING_EFFORT_OPTIONS],
    defaultEnabled: true,
    canDisable: true,
    defaultEffort: "high",
})

export class DeepSeekModelSource extends ModelListingSource {
    readonly providerId = "deepseek"
    readonly providerName = "DeepSeek"
    override readonly requiresApiKey = true
    /** The listing carries no metadata, so stored capabilities and pricing must survive. */
    override readonly reconciliation: ProviderModelReconciliationMode = "overlay-remote"
    protected override readonly defaultBaseUrl = "https://api.deepseek.com"

    /**
     * DeepSeek documents the listing as `GET /models`, unlike the OpenAI-style
     * `/v1/models` the base class assumes. A base URL that already ends in a
     * version segment is left alone so the compatibility path keeps working.
     */
    protected override buildListingUrl(context: ProviderRemoteContext): string {
        const url = new URL(context.baseUrl || this.defaultBaseUrl)
        const pathName = url.pathname.replace(/\/+$/, "")
        url.pathname = /\/models$/i.test(pathName) ? pathName : `${pathName}/models`
        url.search = ""
        url.hash = ""
        return url.toString()
    }

    /**
     * Default native tool calling and thinking on for discovered DeepSeek models.
     *
     * Native tool calling needs `supportsTools === true` and thinking needs a
     * declared `mode`, so a bare `supportsReasoning` flag would enable neither.
     * A capability the listing states explicitly still wins over the default.
     */
    protected override readCapabilities(raw: unknown): ModelCapabilities {
        return {
            contextWindow: this.readContextWindow(raw) ?? DEEPSEEK_CONTEXT_WINDOW,
            maxTokens: this.readMaxTokens(raw) ?? DEEPSEEK_MAX_OUTPUT_TOKENS,
            supportsTools: readSupportedFeature(raw, "tools") ?? true,
            supportsReasoning: readSupportedFeature(raw, "reasoning", "reasoning_effort") ?? true,
            thinking: { ...DEEPSEEK_THINKING, effortLevels: [...DEEPSEEK_REASONING_EFFORT_OPTIONS] },
        }
    }
}

export const deepSeekModelSource = new DeepSeekModelSource()
