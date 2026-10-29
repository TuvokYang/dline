import { fetch } from "@shared/net"
import type { WireResponse } from "../contracts/classification"
import type {
    ExchangeOperationRequest,
    IssueExchangeRequest,
    IssueExchangeTransport,
    RecoverableExchangeTransport,
} from "../contracts/exchangeOperation"
import { DLINE_CONTRACT, type OtlpSignal } from "../contracts/otlpProduction"
import type { ReportAuthorizationTransport, ReportAuthorizeRequest } from "../contracts/reportAuthorization"

export const DLINE_OTEL_ENDPOINT = "https://otel.dline.cc"
/** Bound for one request, connection to last byte; the sender lease outlives it several times over. */
export const DLINE_OTEL_REQUEST_TIMEOUT_MS = 15_000
/** Responses of the service are a few hundred bytes; anything larger is not the service and is not parsed. */
const MAX_RESPONSE_BYTES = 16 * 1024
/** The only device-credential issuer (telemetry-exchange-flow §4). */
const DEVICE_GRANT_PATH = "/auth/device/grant"
const ISSUE_EXCHANGE_PATH = "/auth/exchange"
/** Report Authorization ticket issuance and its read-only status query (telemetry-exchange-flow §5.2, §5.4). */
const REPORT_AUTHORIZATION_PATH = "/auth/report-authorizations"
const REPORT_AUTHORIZATION_STATUS_PATH = "/auth/report-authorizations/status"
const DEVICE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
/** Dline's own protocol paths carry no `/v1`: that segment belongs to OTLP alone. */
const USAGE_PATH = "/usage"
/**
 * OTLP/HTTP keeps its specification path.
 *
 * `/v1` here is part of the OTLP wire convention, not a Dline protocol version:
 * the service accepts standard OTLP only at `/v1/logs|metrics|traces` and does
 * not implement the unprefixed spelling, while Dline's own `/usage` and
 * `/auth/*` take no prefix at all.
 */
const OTLP_PATHS: Readonly<Record<OtlpSignal, string>> = {
    logs: "/v1/logs",
    metrics: "/v1/metrics",
    traces: "/v1/traces",
}
/**
 * Every request names one `X-Dline-Contract` (TADR §2.4, exchange flow §8): `/usage`,
 * `/auth/*` and OTLP alike. It derives from the Usage schema, so the header and
 * `schema_version` never disagree; the service ignores a retired value on `/usage`
 * and OTLP and refuses it with 400 on `/auth/*`.
 */
const CONTRACT = DLINE_CONTRACT

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

interface AuthenticatedTelemetryDelivery {
    readonly accessToken: string
    readonly requestId: string
    /** Exact bytes, sent unchanged on every attempt so a replay is answered as a duplicate (§1.7). */
    readonly body: Uint8Array
}

export interface UsageDelivery extends AuthenticatedTelemetryDelivery {}

export interface DiagnosticDelivery extends AuthenticatedTelemetryDelivery {}

/** Sends one `/usage` request. */
export interface UsageTransport {
    sendUsage(delivery: UsageDelivery, signal?: AbortSignal): Promise<WireResponse>
}

/** Sends one `/logs` request; the body is an OTLP/HTTP JSON logs request. */
export interface DiagnosticLogsTransport {
    sendLogs(delivery: DiagnosticDelivery, signal?: AbortSignal): Promise<WireResponse>
}

/** Sends one production OTLP/HTTP JSON request of one signal with the production token (TADR §2.4). */
export interface OtlpTransport {
    sendOtlp(stream: OtlpSignal, delivery: DiagnosticDelivery, signal?: AbortSignal): Promise<WireResponse>
}

export interface IssueDiagnosticDelivery extends DiagnosticDelivery {
    readonly stream: OtlpSignal
}

export interface IssueDiagnosticTransport {
    sendIssueDiagnostics(delivery: IssueDiagnosticDelivery, signal?: AbortSignal): Promise<WireResponse>
}

export interface DlineOtelHttpClientOptions {
    /**
     * Sent as `User-Agent: Dline/<clientVersion>` (§1.2). The `client.version`
     * of a usage body and the `service.version` of a logs resource must state
     * the same version, so the caller passes the one it puts into those bodies.
     */
    readonly clientVersion: string
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
export class DlineOtelHttpClient
    implements
        RecoverableExchangeTransport,
        IssueExchangeTransport,
        ReportAuthorizationTransport,
        UsageTransport,
        DiagnosticLogsTransport,
        OtlpTransport,
        IssueDiagnosticTransport
{
    private readonly endpoint: URL
    private readonly timeoutMs: number
    private readonly userAgent: string

    constructor(options: DlineOtelHttpClientOptions) {
        this.endpoint = parseEndpoint(options.endpoint ?? DLINE_OTEL_ENDPOINT)
        this.timeoutMs = options.timeoutMs ?? DLINE_OTEL_REQUEST_TIMEOUT_MS
        this.userAgent = `Dline/${options.clientVersion}`
    }

    /** The service origin every request goes to; safe to log, it never carries a path or credentials. */
    get origin(): string {
        return this.endpoint.origin
    }

    requestRecoverableDeviceOrIssueExchange(
        request: ExchangeOperationRequest & object,
        signal?: AbortSignal,
    ): Promise<WireResponse> {
        if (request.operation !== "device.grant") {
            throw new Error("Issue exchange requires the authenticated issue transport")
        }
        return this.post(
            DEVICE_GRANT_PATH,
            {
                "content-type": "application/json",
                "x-dline-contract": CONTRACT,
                "x-dline-request-id": request.request_id,
            },
            JSON.stringify(request),
            signal,
        )
    }

    requestRecoverableIssueExchange(
        request: IssueExchangeRequest,
        deviceAccessToken: string,
        signal?: AbortSignal,
    ): Promise<WireResponse> {
        return this.post(
            ISSUE_EXCHANGE_PATH,
            { ...authenticatedExchangeHeaders(deviceAccessToken), "x-dline-request-id": request.request_id },
            JSON.stringify(request),
            signal,
        )
    }

    requestReportAuthorization(
        request: ReportAuthorizeRequest,
        deviceAccessToken: string,
        signal?: AbortSignal,
    ): Promise<WireResponse> {
        return this.post(
            REPORT_AUTHORIZATION_PATH,
            { ...authenticatedExchangeHeaders(deviceAccessToken), "x-dline-request-id": request.request_id },
            JSON.stringify(request),
            signal,
        )
    }

    /** Read-only, so it carries no request ID: repeating it returns the current state. */
    queryReportAuthorization(authorizationCode: string, deviceAccessToken: string, signal?: AbortSignal): Promise<WireResponse> {
        return this.post(
            REPORT_AUTHORIZATION_STATUS_PATH,
            authenticatedExchangeHeaders(deviceAccessToken),
            JSON.stringify({ authorization_code: authorizationCode }),
            signal,
        )
    }

    sendUsage(delivery: UsageDelivery, signal?: AbortSignal): Promise<WireResponse> {
        return this.post(USAGE_PATH, deliveryHeaders(delivery, CONTRACT), delivery.body, signal)
    }

    sendLogs(delivery: DiagnosticDelivery, signal?: AbortSignal): Promise<WireResponse> {
        return this.sendOtlp("logs", delivery, signal)
    }

    sendOtlp(stream: OtlpSignal, delivery: DiagnosticDelivery, signal?: AbortSignal): Promise<WireResponse> {
        return this.post(OTLP_PATHS[stream], deliveryHeaders(delivery, CONTRACT), delivery.body, signal)
    }

    sendIssueDiagnostics(delivery: IssueDiagnosticDelivery, signal?: AbortSignal): Promise<WireResponse> {
        return this.post(OTLP_PATHS[delivery.stream], deliveryHeaders(delivery, CONTRACT), delivery.body, signal)
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
                headers: { "User-Agent": this.userAgent, ...headers },
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

/** Headers of the `/auth/*` requests that a production device token authenticates. */
function authenticatedExchangeHeaders(deviceAccessToken: string): Record<string, string> {
    if (!DEVICE_TOKEN_PATTERN.test(deviceAccessToken)) throw new Error("Report authorization requires a valid device token")
    return {
        authorization: `Bearer ${deviceAccessToken}`,
        "content-type": "application/json",
        "x-dline-contract": CONTRACT,
    }
}

/** Headers shared by authenticated telemetry requests; each endpoint supplies its one accepted contract. */
function deliveryHeaders(delivery: AuthenticatedTelemetryDelivery, contract: string): Record<string, string> {
    return {
        authorization: `Bearer ${delivery.accessToken}`,
        "content-type": "application/json",
        "x-dline-request-id": delivery.requestId,
        "x-dline-contract": contract,
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
