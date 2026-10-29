/**
 * OpenAI-compatible gateways.
 *
 * The endpoint is whatever the user typed, so the base class URL joining does
 * the real work here. Gateways rarely publish anything beyond model ids, which
 * is why discovery for this provider mainly feeds the settings dropdown.
 */

import type { ProviderModelReconciliationMode } from "../../provider-model-reconciliation"
import { ModelListingSource } from "../model-listing-source"

export class OpenAiModelSource extends ModelListingSource {
    readonly providerId = "openai"
    readonly providerName = "OpenAI Compatible"
    /** Some self-hosted gateways list models without authentication. */
    override readonly requiresApiKey = false
    /** The catalog is whatever the gateway reports; stale entries should disappear. */
    override readonly reconciliation: ProviderModelReconciliationMode = "replace"
    protected override readonly defaultBaseUrl = "https://api.openai.com/v1"
}

export const openAiModelSource = new OpenAiModelSource()
