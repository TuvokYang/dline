import { fetch } from "@shared/net"
import type { DeviceExchangeTransport } from "../auth/DeviceTokenBroker"
import type { WireResponse } from "../contracts/classification"
import type { DeviceExchangeRequest } from "../contracts/wire"

export const DLINE_OTEL_ENDPOINT = "https://otel.dline.cc"
/** Bound for one request, connection to last byte; the sender lease outlives it several times over. */
export const DLINE_OTEL_REQUEST_TIMEOUT_MS = 15_000
/** Responses of the service are a few hundred bytes; anything larger is not the service and is not parsed. */
const MAX_RESPONSE_BYTES = 16 * 1024
const DEVICE_EXCHANGE_PATH = "/v1/auth/device/exchange"
const USAGE_PATH = "/v1/usage"

export type DlineOtelTransportFailure = "timeout" | "aborted" | "network"

/**
 * A request whose outcome is unknown. It carries no URL, header or body, so it
 * can be logged as it is.
 */
export class DlineOtelTransportError extends Error {
    constructor(readonly failure: DlineOtelTransportFailure) {
        super(`Dline telemetry request failed: ${failure}`)
        this.name = "DlineOtelTransportError"
    }
}

export interface UsageDelivery {
    readonly accessToken: string
    readonly requestId: string
    /** Exact bytes, sent unchanged on every attempt so the server's idempotency check holds. */
    readonly body: Uint8Array
}

/** Sends one `/v1/usage` request. */
export interface UsageTransport {
    sendUsage(delivery: UsageDelivery, signal?: AbortSignal): Promise<WireResponse>
}

export interface DlineOtelHttpClientOptions {
    /** Origin of the service; a loopback origin is used for the local contract smoke. */
    readonly endpoint?: string
    readonly timeoutMs?: number
}

/**
 * HTTP transport of the Dline telemetry service.
 *
 * It goes through the shared proxy-aware fetch, refuses redirects so a bearer
 * token never follows a `Location` to another host, bounds every request in
 * time and every response in size, and turns a body that is not JSON into
 * `json: undefined` for the classifiers. It does not retry: retry policy
 * belongs to the delivery layer, which knows whether a replay is safe.
 */
export class DlineOtelHttpClient implements DeviceExchangeTransport, UsageTransport {
    private readonly endpoint: URL
    private readonly timeoutMs: number

    constructor(options: DlineOtelHttpClientOptions = {}) {
        this.endpoint = parseEndpoint(options.endpoint ?? DLINE_OTEL_ENDPOINT)
        this.timeoutMs = options.timeoutMs ?? DLINE_OTEL_REQUEST_TIMEOUT_MS
    }

    /** The service origin every request goes to; safe to log, it never carries a path or credentials. */
    get origin(): string {
        return this.endpoint.origin
    }

    exchange(request: DeviceExchangeRequest, signal?: AbortSignal): Promise<WireResponse> {
        return this.post(DEVICE_EXCHANGE_PATH, { "content-type": "application/json" }, JSON.stringify(request), signal)
    }

    sendUsage(delivery: UsageDelivery, signal?: AbortSignal): Promise<WireResponse> {
        const headers = {
            authorization: `Bearer ${delivery.accessToken}`,
            "content-type": "application/json",
            "x-dline-request-id": delivery.requestId,
        }
        return this.post(USAGE_PATH, headers, delivery.body, signal)
    }

    private async post(
        pathname: string,
        headers: Record<string, string>,
        body: string | Uint8Array,
        signal: AbortSignal | undefined,
    ): Promise<WireResponse> {
        const deadline = new AbortController()
        const timer = setTimeout(() => deadline.abort(), this.timeoutMs)
        const forwardAbort = () => deadline.abort()
        signal?.addEventListener("abort", forwardAbort, { once: true })
        try {
            if (signal?.aborted) throw new DlineOtelTransportError("aborted")
            const response = await fetch(new URL(pathname, this.endpoint), {
                method: "POST",
                headers,
                // fetch accepts only ArrayBuffer-backed views; the copy is at most one 64 KiB body.
                body: typeof body === "string" ? body : Uint8Array.from(body),
                redirect: "error",
                signal: deadline.signal,
            })
            return {
                status: response.status,
                json: parseJson(await readBounded(response)),
                retryAfter: response.headers.get("retry-after"),
            }
        } catch (error) {
            if (error instanceof DlineOtelTransportError) throw error
            if (signal?.aborted) throw new DlineOtelTransportError("aborted")
            if (deadline.signal.aborted) throw new DlineOtelTransportError("timeout")
            throw new DlineOtelTransportError("network")
        } finally {
            clearTimeout(timer)
            signal?.removeEventListener("abort", forwardAbort)
        }
    }
}

/** Read at most {@link MAX_RESPONSE_BYTES}; a longer body is cancelled and treated as unreadable. */
async function readBounded(response: Response): Promise<string | undefined> {
    const reader = response.body?.getReader()
    if (!reader) return undefined
    const chunks: Uint8Array[] = []
    let total = 0
    try {
        for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > MAX_RESPONSE_BYTES) {
                await reader.cancel().catch(() => undefined)
                return undefined
            }
            chunks.push(value)
        }
    } finally {
        reader.releaseLock()
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
}

function parseJson(text: string | undefined): unknown {
    if (text === undefined || text.length === 0) return undefined
    try {
        return JSON.parse(text) as unknown
    } catch {
        return undefined
    }
}

/**
 * Read an endpoint override from the environment. Only a loopback origin is
 * honoured, so an inherited variable can point the client at the local contract
 * smoke but can never send the device secret to another remote host.
 */
export function loopbackEndpointOverride(value: string | undefined): string | undefined {
    if (!value) return undefined
    try {
        return isLoopback(parseEndpoint(value)) ? value : undefined
    } catch {
        return undefined
    }
}

/** Only HTTPS, or plain HTTP to loopback for the local contract smoke, may carry a device secret. */
function parseEndpoint(value: string): URL {
    const url = new URL(value)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
        throw new Error("Dline telemetry endpoint must use HTTPS")
    }
    if (url.username || url.password || url.search || url.hash) throw new Error("Dline telemetry endpoint must be a bare origin")
    return url
}

function isLoopback(url: URL): boolean {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
}
