export const CLINE_PROVIDER_DEFAULT_API_BASE_URL = "https://api.cline.bot"
export const CLINE_PROVIDER_APP_URL = "https://app.cline.bot"

/** Resolve the API origin owned by one Cline Provider Profile. */
export function resolveClineProviderApiBaseUrl(baseUrl?: string): string {
    const configured = baseUrl?.trim()
    return (configured || CLINE_PROVIDER_DEFAULT_API_BASE_URL).replace(/\/+$/, "")
}
