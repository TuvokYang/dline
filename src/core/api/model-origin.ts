/**
 * Providers that run on the user's own machine or behind the user's own proxy.
 * Whatever they serve is the user's model, however its ID reads.
 */
const USER_HOSTED_PROVIDERS: ReadonlySet<string> = new Set(["ollama", "lmstudio", "litellm"])

/** What decides whether a handler's model is the user's own rather than a built-in catalog model. */
export interface ModelOriginFacts {
    readonly providerId: string
    readonly modelId: string
    /** The Profile's endpoint override; empty when the provider's own endpoint is used. */
    readonly baseUrl?: string
    /** The provider's built-in endpoint, when the seed catalog names one. */
    readonly defaultBaseUrl?: string
    /** The catalog entry for this model; absent when the provider's catalog does not list it. */
    readonly catalogModel?: { readonly userDefined?: boolean }
}

/**
 * Whether a model is the user's own: served by a user-hosted provider, reached
 * through an endpoint other than the provider's, or absent from the built-in
 * catalog (a user-added entry counts as absent).
 *
 * Telemetry reports such a model only as `_custom`, so its ID never leaves the
 * machine. Any doubt resolves to custom: an endpoint the seed catalog cannot
 * vouch for is treated as the user's.
 */
export function isCustomModel(facts: ModelOriginFacts): boolean {
    if (USER_HOSTED_PROVIDERS.has(facts.providerId)) return true
    if (usesOwnEndpoint(facts.baseUrl, facts.defaultBaseUrl)) return true
    return !facts.catalogModel || facts.catalogModel.userDefined === true
}

function usesOwnEndpoint(baseUrl: string | undefined, defaultBaseUrl: string | undefined): boolean {
    const configured = normalizedEndpoint(baseUrl)
    if (!configured) return false
    return configured !== normalizedEndpoint(defaultBaseUrl)
}

function normalizedEndpoint(url: string | undefined): string | undefined {
    const trimmed = url?.trim().replace(/\/+$/, "").toLowerCase()
    return trimmed ? trimmed : undefined
}
