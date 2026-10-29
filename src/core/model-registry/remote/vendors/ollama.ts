/**
 * Ollama `GET /api/tags`.
 *
 * The local daemon returns `{ models: [...] }` rather than the OpenAI-style
 * `{ data: [...] }`, and publishes no context window or pricing. Capability
 * gaps stay undefined so the stored catalog entry keeps whatever the user or
 * the seed already established.
 */
import type { ModelCapabilities } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { isRecord, ModelListingSource, readString } from "../model-listing-source"
import type { ProviderRemoteContext } from "../model-source"

export class OllamaModelSource extends ModelListingSource {
    readonly providerId = "ollama"
    readonly providerName = "Ollama"
    override readonly requiresApiKey: boolean = false
    override readonly reconciliation: ProviderModelReconciliationMode = "replace"
    protected override readonly defaultBaseUrl = "http://localhost:11434"

    protected override buildListingUrl(context: ProviderRemoteContext): string {
        const base = (context.baseUrl || this.defaultBaseUrl).replace(/\/+$/, "")
        return `${base}/api/tags`
    }

    protected override readPageEntries(payload: unknown): unknown[] {
        if (!isRecord(payload)) {
            return []
        }
        return Array.isArray(payload.models) ? payload.models : []
    }

    protected override readModelId(raw: unknown): string | undefined {
        return readString(raw, "name", "model")
    }

    /** `/api/tags` describes the local weights, not a context window. */
    protected override readCapabilities(): ModelCapabilities {
        return {}
    }

    protected override readDescription(raw: unknown): string | undefined {
        const family = readString(raw, "details.family")
        const parameterSize = readString(raw, "details.parameter_size")
        const quantization = readString(raw, "details.quantization_level")
        const parts = [family, parameterSize, quantization].filter((part): part is string => part !== undefined)
        return parts.length > 0 ? parts.join(" · ") : undefined
    }
}

export const ollamaModelSource = new OllamaModelSource()
