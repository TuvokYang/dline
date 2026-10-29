import { fetch } from "@shared/net"
import { buildExternalBasicHeaders } from "@/services/EnvUtils"
import { FEATURE_FLAGS_SCHEMA_VERSION, type FeatureFlagsDocument, parseFeatureFlagsDocument } from "./flagsDocument"

export const DLINE_FEATURES_ENDPOINT = "https://dev.dline.cc"
/** Bound for one request, connection to last byte; a slow answer only delays a rollout. */
export const FEATURES_REQUEST_TIMEOUT_MS = 10_000
/** A flags document is a few hundred bytes; anything larger is not the service and is not parsed. */
const MAX_RESPONSE_BYTES = 64 * 1024
const FEATURES_PATH = "/features"

/** What the service may target a rollout by, besides the device. None of it identifies the user. */
export interface FeatureFlagsQuery {
    readonly version: string
    readonly platform: string
    /** The flags this client asks about; the service answers only these. */
    readonly flags: readonly string[]
}

export type FeatureFlagsFetchFailure = "no_device" | "timeout" | "aborted" | "network" | "status" | "invalid_document"

/** A failed fetch. It carries no URL or body, so it can be logged as it is. */
export class FeatureFlagsFetchError extends Error {
    constructor(
        readonly failure: FeatureFlagsFetchFailure,
        readonly status?: number,
    ) {
        super(`Dline feature flags request failed: ${failure}${status === undefined ? "" : ` (${status})`}`)
        this.name = "FeatureFlagsFetchError"
    }
}

/** Where the remote rollout answers come from. */
export interface FeatureFlagsSource {
    /**
     * Ask for the answers once. `requestId` names this request; the same id is
     * never reused for another request, so the service can recognise a repeat.
     */
    fetchFlags(requestId: string, signal?: AbortSignal): Promise<FeatureFlagsDocument>
}

export interface FeatureFlagsHttpSourceOptions {
    readonly query: FeatureFlagsQuery
    /**
     * The device id the usage service issued, or `undefined` when there is none
     * right now. It is the same device id usage delivery reports under.
     */
    readonly deviceId: (signal?: AbortSignal) => Promise<string | undefined>
    /** Origin of the service; tests use a loopback origin. */
    readonly endpoint?: string
    readonly timeoutMs?: number
}

/**
 * HTTP client of the Dline feature service.
 *
 * The device id and the query travel in a POST body rather than the URL:
 * proxies, CDNs and access logs record URLs, and an answer computed for one
 * device must not be cached for another. Without a device id nothing is sent.
 * No credential is sent either: the device id is not a secret, and the usage
 * token is a write credential that stays with the usage service. Goes
 * through the shared proxy-aware fetch, refuses redirects, bounds each request
 * in time and each response in size, and does not retry: the provider owns the
 * schedule and keeps its last answers when a fetch fails.
 */
export class FeatureFlagsHttpSource implements FeatureFlagsSource {
    private readonly url: URL
    private readonly query: FeatureFlagsQuery
    private readonly timeoutMs: number
    private readonly deviceId: FeatureFlagsHttpSourceOptions["deviceId"]

    constructor(options: FeatureFlagsHttpSourceOptions) {
        this.url = new URL(FEATURES_PATH, parseFeaturesEndpoint(options.endpoint ?? DLINE_FEATURES_ENDPOINT))
        this.query = options.query
        this.deviceId = options.deviceId
        this.timeoutMs = options.timeoutMs ?? FEATURES_REQUEST_TIMEOUT_MS
    }

    /** The service origin; safe to log, it carries no path or credentials. */
    get origin(): string {
        return this.url.origin
    }

    async fetchFlags(requestId: string, signal?: AbortSignal): Promise<FeatureFlagsDocument> {
        // Acquired before the request deadline starts: an enrollment has its own bound.
        const deviceId = await this.acquireDeviceId(signal)
        const deadline = new AbortController()
        const timer = setTimeout(() => deadline.abort(), this.timeoutMs)
        const forwardAbort = () => deadline.abort()
        signal?.addEventListener("abort", forwardAbort, { once: true })
        try {
            if (signal?.aborted) throw new FeatureFlagsFetchError("aborted")
            const response = await fetch(this.url, {
                method: "POST",
                // Every Dline client announces itself with the same agent; the runtime default would only say "node".
                headers: {
                    ...buildExternalBasicHeaders(),
                    accept: "application/json",
                    "content-type": "application/json",
                    "x-dline-request-id": requestId,
                },
                body: JSON.stringify({
                    schema_version: FEATURE_FLAGS_SCHEMA_VERSION,
                    device_id: deviceId,
                    version: this.query.version,
                    platform: this.query.platform,
                    flags: this.query.flags,
                }),
                redirect: "error",
                signal: deadline.signal,
            })
            if (!response.ok) {
                await response.body?.cancel().catch(() => undefined)
                throw new FeatureFlagsFetchError("status", response.status)
            }
            const document = parseFeatureFlagsDocument(parseJson(await readBounded(response)))
            if (!document) throw new FeatureFlagsFetchError("invalid_document")
            return document
        } catch (error) {
            if (error instanceof FeatureFlagsFetchError) throw error
            if (signal?.aborted) throw new FeatureFlagsFetchError("aborted")
            if (deadline.signal.aborted) throw new FeatureFlagsFetchError("timeout")
            throw new FeatureFlagsFetchError("network")
        } finally {
            clearTimeout(timer)
            signal?.removeEventListener("abort", forwardAbort)
        }
    }

    private async acquireDeviceId(signal: AbortSignal | undefined): Promise<string> {
        if (signal?.aborted) throw new FeatureFlagsFetchError("aborted")
        let deviceId: string | undefined
        try {
            deviceId = await this.deviceId(signal)
        } catch {
            // The error may describe the enrollment exchange; only the outcome leaves here.
            deviceId = undefined
        }
        if (signal?.aborted) throw new FeatureFlagsFetchError("aborted")
        if (!deviceId) throw new FeatureFlagsFetchError("no_device")
        return deviceId
    }
}

/**
 * Read an endpoint override from the environment. Only a loopback origin is
 * honoured, so an inherited variable can point a test at a local service but
 * cannot hand the rollout of a real installation to another host.
 */
export function loopbackFeaturesEndpointOverride(value: string | undefined): string | undefined {
    if (!value) return undefined
    try {
        return isLoopback(parseFeaturesEndpoint(value)) ? value : undefined
    } catch {
        return undefined
    }
}

function parseFeaturesEndpoint(value: string): URL {
    const url = new URL(value)
    if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url))) {
        throw new Error("Dline feature service endpoint must use HTTPS")
    }
    if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
        throw new Error("Dline feature service endpoint must be a bare origin")
    }
    return url
}

function isLoopback(url: URL): boolean {
    return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]"
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
    return new TextDecoder().decode(Buffer.concat(chunks))
}

function parseJson(text: string | undefined): unknown {
    if (!text) return undefined
    try {
        return JSON.parse(text) as unknown
    } catch {
        return undefined
    }
}
