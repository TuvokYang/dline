/**
 * Groq `GET /openai/v1/models`.
 *
 * Groq speaks the OpenAI listing shape but publishes no prices, so its catalog
 * overlays the built-in metadata instead of replacing it.
 */

import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { ModelListingSource, readPositiveNumber } from "../model-listing-source"

/** Ids that Groq lists but that cannot serve a chat completion. */
const NON_CHAT_GROQ_MARKERS = ["guard", "allam"]

export class GroqModelSource extends ModelListingSource {
    readonly providerId = "groq"
    readonly providerName = "Groq"
    override readonly reconciliation: ProviderModelReconciliationMode = "overlay-remote"
    protected override readonly defaultBaseUrl = "https://api.groq.com/openai/v1"

    protected override isChatModel(raw: unknown): boolean {
        if (!super.isChatModel(raw)) {
            return false
        }
        const modelId = this.readModelId(raw)?.toLowerCase() ?? ""
        return !NON_CHAT_GROQ_MARKERS.some((marker) => modelId.includes(marker))
    }

    protected override readContextWindow(raw: unknown): number | undefined {
        return readPositiveNumber(raw, "context_window")
    }
}

export const groqModelSource = new GroqModelSource()
