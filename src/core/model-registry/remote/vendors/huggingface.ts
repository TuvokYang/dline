/**
 * Hugging Face router `GET /v1/models`.
 *
 * The router lists which inference providers serve a model but publishes no
 * context window, token limit, or price. The catalog therefore overlays the
 * built-in metadata: seeded models keep their static values and the listing
 * only contributes the routing description and any newly available ids.
 */

import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { ModelListingSource, readString } from "../model-listing-source"

export class HuggingFaceModelSource extends ModelListingSource {
    readonly providerId = "huggingface"
    readonly providerName = "Hugging Face"
    override readonly requiresApiKey = false
    override readonly reconciliation: ProviderModelReconciliationMode = "overlay-remote"
    protected override readonly defaultBaseUrl = "https://router.huggingface.co/v1"

    protected override readDescription(raw: unknown): string {
        const providers = this.readServingProviders(raw)
        return `Available on providers: ${providers.length > 0 ? providers.join(", ") : "unknown"}`
    }

    /** Names of the inference providers that currently serve the model. */
    private readServingProviders(raw: unknown): string[] {
        if (typeof raw !== "object" || raw === null) {
            return []
        }
        const entries = (raw as Record<string, unknown>).providers
        if (!Array.isArray(entries)) {
            return []
        }
        const names: string[] = []
        for (const entry of entries) {
            const name = readString(entry, "provider")
            if (name) {
                names.push(name)
            }
        }
        return names
    }
}

export const huggingFaceModelSource = new HuggingFaceModelSource()
