/**
 * Hicap `GET /v2/openai/models`.
 *
 * The listing returns ids only, so every model is published with the same
 * assumed capability envelope. Authentication uses a bare `api-key` header
 * rather than a bearer token.
 */
import type { ModelCapabilities, ModelPricing } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { ModelListingSource } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

/** The listing carries no capability data, so these mirror the previous defaults. */
const ASSUMED_CONTEXT_WINDOW = 128_000
const UNKNOWN_MAX_TOKENS = -1

export class HicapModelSource extends ModelListingSource {
    readonly providerId = "hicap"
    readonly providerName = "Hicap"
    override readonly reconciliation: ProviderModelReconciliationMode = "replace"
    protected override readonly defaultBaseUrl = "https://api.hicap.ai/v2/openai"

    protected override buildHeaders(context: ProviderRemoteContext): Record<string, string> {
        return context.apiKey ? { "api-key": context.apiKey } : {}
    }

    protected override readDescription(): string {
        return ""
    }

    protected override readCapabilities(): ModelCapabilities {
        return {
            maxTokens: UNKNOWN_MAX_TOKENS,
            contextWindow: ASSUMED_CONTEXT_WINDOW,
            supportsImages: true,
            supportsPromptCache: true,
        }
    }

    protected override readPricing(): ModelPricing {
        return { inputPrice: 0, outputPrice: 0, cacheWritesPrice: 0, cacheReadsPrice: 0 }
    }
}

export const hicapModelSource = new HicapModelSource()
