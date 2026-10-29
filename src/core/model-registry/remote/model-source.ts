/**
 * Remote model sources — the boundary between vendor listing endpoints and the
 * provider registry.
 *
 * Implementations translate a vendor response into plain `ModelInfo` records so
 * that no vendor wire format leaks past this file. Vendors that speak the common
 * `{ data: [...] }` listing shape should extend `ModelListingSource` instead of
 * implementing this interface directly.
 */
import type { ModelInfo } from "@shared/providers/types"
import type { ProviderModelReconciliationMode } from "../provider-model-reconciliation"

/** Everything a source needs in order to reach a vendor. */
export interface ProviderRemoteContext {
    /** Stable Profile identity used by sources that own Profile-scoped credentials. */
    readonly profileId?: string
    /** Absent when the vendor lists its catalog without authentication. */
    readonly apiKey?: string
    /** Absent when the vendor exposes a single fixed endpoint. */
    readonly baseUrl?: string
    readonly signal?: AbortSignal
    /**
     * Vendor-specific credential fields that do not generalise, such as an
     * OAuth client pair or a tenant scope. Only the owning source reads these,
     * so the shared context stays free of one-vendor properties.
     */
    readonly vendorCredentials?: Readonly<Record<string, string>>
}

/** A vendor-specific way to enumerate models over the network. */
export interface ProviderRemoteSource {
    readonly providerId: string
    readonly providerName: string
    /** When true, a missing key short-circuits discovery instead of sending a request. */
    readonly requiresApiKey: boolean
    /**
     * How a discovered catalog combines with the stored one. Vendors whose
     * catalog is fully derived from the listing use `replace`; vendors whose
     * listing only supplements local metadata use `overlay-remote`.
     */
    readonly reconciliation: ProviderModelReconciliationMode
    /** Billing mode recorded on the persisted catalog. */
    readonly billingMode: string
    /** Model id preferred as the catalog default when the stored default is gone. */
    readonly preferredDefaultModelId?: string
    fetchModels(context: ProviderRemoteContext): Promise<Record<string, ModelInfo>>
}
