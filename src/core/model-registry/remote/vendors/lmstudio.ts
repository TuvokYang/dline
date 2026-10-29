/**
 * LM Studio `GET /api/v0/models`.
 *
 * The REST API returns `{ data: [...] }` where each entry carries a `type`
 * discriminator and `max_context_length`. Embedding models are excluded so the
 * catalog only lists things a chat request can target.
 */
import type { ModelCapabilities } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readPositiveNumber, readString } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

/** `type` values the daemon reports for models that cannot serve chat turns. */
const NON_CHAT_TYPES = ["embeddings", "embedding"]

export class LmStudioModelSource extends ModelListingSource {
    readonly providerId = "lmstudio"
    readonly providerName = "LM Studio"
    override readonly requiresApiKey: boolean = false
    override readonly reconciliation: ProviderModelReconciliationMode = "replace"
    protected override readonly defaultBaseUrl = "http://localhost:1234"

    protected override buildListingUrl(context: ProviderRemoteContext): string {
        return new URL("api/v0/models", context.baseUrl || this.defaultBaseUrl).href
    }

    protected override isChatModel(raw: unknown): boolean {
        if (!isRecord(raw)) {
            return false
        }
        const type = readString(raw, "type")?.toLowerCase()
        if (type && NON_CHAT_TYPES.includes(type)) {
            return false
        }
        return super.isChatModel(raw)
    }

    protected override readContextWindow(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "max_context_length", "loaded_context_length") ?? super.readContextWindow(raw)
    }

    protected override readCapabilities(raw: unknown): ModelCapabilities {
        return {
            contextWindow: this.readContextWindow(raw),
            supportsImages: readString(raw, "type")?.toLowerCase() === "vlm" ? true : undefined,
        }
    }

    protected override readDescription(raw: unknown): string | undefined {
        const publisher = readString(raw, "publisher")
        const quantization = readString(raw, "quantization")
        const parts = [publisher, quantization].filter((part): part is string => part !== undefined)
        return parts.length > 0 ? parts.join(" · ") : undefined
    }
}

export const lmStudioModelSource = new LmStudioModelSource()
