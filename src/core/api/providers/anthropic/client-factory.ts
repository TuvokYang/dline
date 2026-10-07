import { Anthropic } from "@anthropic-ai/sdk"
import { providerFetch } from "@shared/net"

/**
 * How a client authenticates to the Messages API.
 *
 * A subscription OAuth token is a bearer credential, not an API key: sending it as `x-api-key` is rejected.
 */
export type AnthropicCredential = { kind: "api_key"; apiKey: string } | { kind: "bearer"; token: string }

export interface AnthropicClientOptions {
	baseUrl?: string
	defaultHeaders?: Record<string, string>
}

/**
 * Create a Messages API client on the shared provider transport.
 *
 * SDK retries stay off because request-level retry belongs to the provider's `withRetry` policy.
 */
export function createAnthropicClient(credential: AnthropicCredential, options: AnthropicClientOptions = {}): Anthropic {
	return new Anthropic({
		...(credential.kind === "api_key" ? { apiKey: credential.apiKey } : { apiKey: null, authToken: credential.token }),
		...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
		...(options.defaultHeaders ? { defaultHeaders: options.defaultHeaders } : {}),
		maxRetries: 0,
		fetch: providerFetch,
	})
}
