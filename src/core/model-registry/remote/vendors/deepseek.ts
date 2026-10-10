/**
 * DeepSeek `GET /models`.
 *
 * The listing only reports ids (`{ object: "list", data: [{ id, object,
 * owned_by }] }`), so window and output limits come from the documented
 * platform defaults rather than the response. DeepSeek publishes no prices in
 * this endpoint, which keeps stored pricing intact.
 */
import type { ModelCapabilities } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { ModelListingSource } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

/** Documented platform defaults; the listing endpoint reports neither value. */
const DEEPSEEK_CONTEXT_WINDOW = 1_000_000
const DEEPSEEK_MAX_OUTPUT_TOKENS = 384_000

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

    protected override readCapabilities(raw: unknown): ModelCapabilities {
        return {
            contextWindow: this.readContextWindow(raw) ?? DEEPSEEK_CONTEXT_WINDOW,
            maxTokens: this.readMaxTokens(raw) ?? DEEPSEEK_MAX_OUTPUT_TOKENS,
        }
    }
}

export const deepSeekModelSource = new DeepSeekModelSource()
