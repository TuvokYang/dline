/**
 * Requesty `GET /v1/models`.
 *
 * Requesty publishes explicit capability flags and per-token string prices, and
 * its base URL is user-configurable through the router CNAME.
 */

import { toRequestyServiceUrl } from "@shared/clients/requesty"
import type { ModelCapabilities, ModelPricing } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readPerMillionPrice, readPositiveNumber, readString } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

function readFlag(raw: unknown, field: string): boolean | undefined {
    if (!isRecord(raw) || typeof raw[field] !== "boolean") {
        return undefined
    }
    return raw[field]
}

export class RequestyModelSource extends ModelListingSource {
    readonly providerId = "requesty"
    readonly providerName = "Requesty"
    override readonly reconciliation: ProviderModelReconciliationMode = "replace"
    protected override readonly defaultBaseUrl = "https://router.requesty.ai/v1"

    /** The router host is configurable, so resolve it through the shared client helper. */
    protected override buildListingUrl(context: ProviderRemoteContext): string {
        const resolved = toRequestyServiceUrl(context.baseUrl || this.defaultBaseUrl)
        if (resolved == null) {
            throw new Error("Requesty base URL is not valid.")
        }
        return new URL(`${resolved.pathname}/models`, resolved).toString()
    }

    protected override readContextWindow(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "context_window")
    }

    protected override readMaxTokens(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "max_output_tokens")
    }

    protected override readDescription(raw: unknown): string | undefined {
        return readString(raw, "description")
    }

    protected override readCapabilities(raw: unknown): ModelCapabilities {
        return {
            maxTokens: this.readMaxTokens(raw),
            contextWindow: this.readContextWindow(raw),
            supportsImages: readFlag(raw, "supports_vision"),
            supportsPromptCache: readFlag(raw, "supports_caching"),
        }
    }

    protected override readPricing(raw: unknown): ModelPricing {
        return {
            inputPrice: readPerMillionPrice(raw, "input_price") ?? 0,
            outputPrice: readPerMillionPrice(raw, "output_price") ?? 0,
            cacheWritesPrice: readPerMillionPrice(raw, "caching_price") ?? 0,
            cacheReadsPrice: readPerMillionPrice(raw, "cached_price") ?? 0,
        }
    }
}

export const requestyModelSource = new RequestyModelSource()
