# Networking, Proxy, and Provider Observability

Dline currently runs as a VS Code extension. Extension-host network traffic must use the shared transport layer so corporate proxies, cancellation, request headers, timeouts, and provider-attempt observability remain consistent.

## Core and extension code

Do not use global `fetch` or a default Axios instance outside the shared networking implementation.

Non-provider traffic uses `fetch` from `@shared/net`; Axios uses `getAxiosSettings()` from the same module. Load `using-shared-network` for the complete fetch/Axios/providerFetch examples, SDK injection, bounded cancellation, stream cleanup, and scoped transport mocking skills.

`src/shared/net.ts` is allowed to use lower-level primitives because it owns the wrappers.

## Provider traffic

Model generation requests use `providerFetch` so the request participates in provider-attempt observation and shared transport behavior. Auxiliary metadata/account traffic is not automatically a generation attempt.

For OpenAI-compatible SDKs, prefer `createOpenAIClient()` or the provider-specific shared factory, such as `createOpenAIClientForProfile()`. These factories inject `providerFetch`, proxy support, external headers, and profile-specific authentication behavior.

Do not construct a raw OpenAI client with global fetch when an existing factory applies. If a third-party SDK accepts a custom fetch/dispatcher/agent, inject the shared Dline transport.

Use plain shared `fetch` only for non-provider network traffic that should not be counted as an API generation attempt.

## Webview code

The Webview runs in the browser/embedder network environment and may use browser `fetch`. Do not import Node proxy agents into the Webview bundle.

Security-sensitive authorization and secret-bearing requests should remain in the extension/core host unless the product contract explicitly places them in the Webview.

## Required behavior

Every new network boundary must define:

- finite timeout or inherited bounded timeout;
- `AbortSignal` propagation where cancellation is possible;
- retry conditions, maximum attempts, and idempotency;
- sanitized errors that do not expose tokens, headers, account payloads, or request bodies;
- proxy behavior for standalone and IDE hosts;
- response-body cleanup when a stream consumer stops early;
- telemetry/observability ownership without logging sensitive content.

Do not retry authentication, billing, or non-idempotent writes generically.

## Verification ownership

The changed boundary must demonstrate shared transport/SDK injection, signal and timeout propagation, retry/fallback identity, stream cleanup, and sanitized failures as applicable. Proxy behavior for the target host must be covered or explicitly reported as unverified. `using-shared-network` contains the concrete `mockFetchForTesting` callback-lifetime, status/error, cancellation, and resource-cleanup examples.

Load `add-new-provider` for provider-specific model and accounting techniques.
