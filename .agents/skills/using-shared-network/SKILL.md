---
name: using-shared-network
description: Use Dline shared fetch, Axios and provider SDK transports; implement request cancellation and response/stream cleanup, and write callback-scoped transport mocks.
---

# Use Shared Network Transports

`network` owns the transport and proxy contract. This skill shows the call shapes, SDK injection and resource-lifetime techniques used at a request boundary.

## Select the Transport at the Call Site

For extension/core traffic, select by the operation:

- Non-generation HTTP uses shared `fetch`.
- Existing Axios code uses `getAxiosSettings()` to inject the shared fetch adapter.
- Model generation uses `providerFetch` or the shared provider SDK factory, inside the ApiHandler's provider-attempt scope.

A model-list or account-usage read is auxiliary traffic even when its caller is a provider handler. `providerFetch` observes a real send under its existing attempt identity; it does not create a new generation attempt for an arbitrary metadata request.

The following fragments use the caller's `url` and `signal`:

```typescript
import { fetch } from "@shared/net"

const response = await fetch(url, { signal })
```

```typescript
import axios from "axios"
import { getAxiosSettings } from "@shared/net"

const response = await axios.get(url, {
  signal,
  ...getAxiosSettings(),
})
```

```typescript
import { providerFetch } from "@shared/net"

const response = await providerFetch(url, { method: "POST", signal })
```

Use Axios's `timeout` or an inherited bounded signal for its deadline. Consume or cancel the returned response at the owning call site.

## Inject an SDK Client

For a generic OpenAI-compatible endpoint:

```typescript
import { createOpenAIClient } from "@shared/net"

const client = createOpenAIClient({ apiKey, baseURL, timeout: 30_000 })
```

For an existing Profile:

```typescript
import { createOpenAIClientForProfile } from "@core/api/providers/openai-client-factory"

const client = createOpenAIClientForProfile(profile)
```

The Profile factory supplies its Azure/API-key/identity and header choices as well as shared transport. Pass the operation's signal at the send. For another SDK, inspect the adapter's actual fetch/dispatcher/agent injection option; the option names and supported value types differ across SDKs.

## Keep the Deadline Through Body Consumption

Shared fetch does not supply a universal timeout. This example joins a caller's cancellation with a five-second deadline:

```typescript
import { fetch } from "@shared/net"

async function readHealth(url: string, signal: AbortSignal): Promise<string> {
    const request = new AbortController()
    const cancel = () => request.abort(signal.reason)
    if (signal.aborted) cancel()
    else signal.addEventListener("abort", cancel, { once: true })
    const deadline = setTimeout(() => request.abort(new Error("Health request timed out")), 5_000)
    try {
        const response = await fetch(url, { signal: request.signal })
        if (!response.ok) {
            await response.body?.cancel()
            throw new Error(`Health request failed (${response.status})`)
        }
        return await response.text()
    } finally {
        clearTimeout(deadline)
        signal.removeEventListener("abort", cancel)
    }
}
```

The `await` in `return await response.text()` matters: returning the Promise directly would run `finally` and clear the deadline while the body was still being read. Keep the same ownership for auxiliary requests, so cancellation settles the whole operation. Use an existing request-owner helper when the module already has this lifetime handling.

## Close a Stream on Consumer Exit

For an async generator, place owned reader/body cleanup around the yielding loop so breaking after a chunk reaches cleanup as well as EOF or a parse error. A protocol terminator can arrive before transport EOF; use the protocol's drain/close behavior so trailing usage is retained.

`src/core/api/providers/__tests__/dify.test.ts` has a concrete early-break case with a real ReadableStream cancellation hook and an `ApiHandler.bindProviderAttemptScope` observer. Follow both resource cancellation and terminal attempt status. Its separate EOF case shows normal completion, rather than treating every loop exit as cancellation. Keep primary parse/transport failures when cleanup also fails.

## Mock the Shared Transport for the Full Async Operation

`mockFetchForTesting(theFetch, callback)` restores the shared transport when the callback returns, or when its returned Promise settles. Include request and response consumption in that Promise:

```typescript
import { mockFetchForTesting } from "@shared/net"
import { expect, it } from "vitest"

it("rejects HTTP failures and propagates an already-aborted caller", async () => {
    const transport: typeof globalThis.fetch = async (_input, init) => {
        if (init?.signal?.aborted) throw init.signal.reason
        return new Response("unavailable", { status: 503 })
    }
    await mockFetchForTesting(transport, async () => {
        await expect(readHealth("https://example.invalid/health", new AbortController().signal))
            .rejects.toBeInstanceOf(Error)
        const caller = new AbortController()
        const reason = new Error("Cancelled by test")
        caller.abort(reason)
        await expect(readHealth("https://example.invalid/health", caller.signal)).rejects.toBe(reason)
    })
})
```

Starting `readHealth` in a synchronous callback without returning its Promise restores the mock before completion. The hook is process-scoped, so overlapping mock lifetimes interfere. Replacing globalThis.fetch does not replace the shared wrapper. The example's fake transport models status and already-aborted input; use the owning module's stream fixture for streaming and the host setup for actual proxy behavior.
