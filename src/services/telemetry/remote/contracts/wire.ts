/**
 * Wire contract of the Dline OTEL service (`otel.dline.cc`): the response
 * envelope `/usage` and the OTLP endpoints share (usage-contract §15, TADR §2.4).
 * The device grant lives in `deviceGrant.ts` and the usage body in `usageBody.ts`.
 *
 * Parsers validate only the fields the client acts on and ignore everything
 * else, so a server that adds fields does not break delivery.
 */

export type RemoteProfile = "usage" | "production" | "development"

/**
 * How the service settled a request it confirmed.
 *
 * `accepted` stored the batch, `duplicate` recognised the same request ID and
 * bytes as an earlier attempt, and `ignored_version` confirms the request
 * without a business write.
 */
export type DeliveryDisposition = "accepted" | "duplicate" | "ignored_version"
const DELIVERY_DISPOSITIONS: readonly DeliveryDisposition[] = ["accepted", "duplicate", "ignored_version"]

/** A confirmed request and the earliest time, server epoch milliseconds, the next new request may follow. */
export interface DeliveryAcknowledgement {
    readonly disposition: DeliveryDisposition
    readonly nextEligibleAt: number
}

/**
 * The success envelope `{ok: true, request_id, disposition, next_eligible_at}`.
 * Without a known disposition and its gate a 200 confirms nothing, so the
 * caller replays the same bytes instead of dropping them.
 */
export function parseAcknowledgement(body: unknown): DeliveryAcknowledgement | undefined {
    if (!isRecord(body) || body.ok !== true) return undefined
    const disposition = DELIVERY_DISPOSITIONS.find((value) => value === body.disposition)
    const next = body.next_eligible_at
    if (!disposition || !isSafeNonNegativeInteger(next)) return undefined
    return { disposition, nextEligibleAt: next }
}

/**
 * Why the service refused a report status query, as it names the refusal
 * (report-authorization-status-refresh design §12.3).
 *
 * The enum belongs to the query pool alone. A `report_mutation` refusal carries
 * no equivalent value, so reading one there would turn an ordinary refusal into
 * a fail-closed failure.
 */
export const REPORT_QUERY_REFUSAL_REASONS = [
    "device_window",
    "device_day",
    "global_query_day",
    "query_ingress",
    "read_budget",
] as const
export type ReportQueryRefusalReason = (typeof REPORT_QUERY_REFUSAL_REASONS)[number]

/**
 * The failure envelope `{ok: false, error: {code, path?}}`. `retry_after_ms`,
 * `next_eligible_at`, `server_time` and `reason` sit at the top level and appear
 * only where they apply; some edge answers carry no body at all.
 */
export interface ServiceError {
    readonly code?: string
    /**
     * `error.path` of a contract refusal: the body location the service could not
     * accept. It is kept for local, bounded diagnostics because a 422 says nothing
     * else about which field was wrong.
     */
    readonly path?: string
    /** The body's `retry_after_ms`, else `Retry-After` relative to the local clock. */
    readonly retryAfterMs?: number
    /** Server epoch milliseconds. */
    readonly nextEligibleAt?: number
    /** Present only when a report status query was refused. */
    readonly reason?: ReportQueryRefusalReason
    /** Server epoch milliseconds; the service clock `nextEligibleAt` was stated on. */
    readonly serverTime?: number
}

export function parseServiceError(body: unknown, retryAfterHeader: string | null, now = Date.now()): ServiceError {
    const envelope: Record<string, unknown> = isRecord(body) ? body : {}
    const error = isRecord(envelope.error) ? envelope.error : undefined
    const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : undefined
    const path = typeof error?.path === "string" && error.path.length > 0 ? error.path : undefined
    const delay = envelope.retry_after_ms
    const retryAfterMs = isSafeNonNegativeInteger(delay) ? delay : parseRetryAfterMs(retryAfterHeader, now)
    const next = envelope.next_eligible_at
    const reason = REPORT_QUERY_REFUSAL_REASONS.find((allowed) => allowed === envelope.reason)
    const serverTime = envelope.server_time
    return {
        ...(code ? { code } : {}),
        ...(path ? { path } : {}),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(isSafeNonNegativeInteger(next) ? { nextEligibleAt: next } : {}),
        ...(reason === undefined ? {} : { reason }),
        ...(isSafeNonNegativeInteger(serverTime) ? { serverTime } : {}),
    }
}

/** How long a failure asks the client to wait: its `next_eligible_at` gate wins over any delay. */
export function serviceWaitMs(error: ServiceError, now: number): number | undefined {
    return error.nextEligibleAt === undefined ? error.retryAfterMs : Math.max(0, error.nextEligibleAt - now)
}

/**
 * The wait a refusal named, measured on the service's own clock.
 *
 * `next_eligible_at - server_time` cannot be shortened or stretched by a skewed
 * local clock, and a `Retry-After` header that was already rounded to whole
 * seconds is not used to rebuild an absolute millisecond deadline. A body
 * `retry_after_ms` is the only fallback; `undefined` means no delay was named.
 */
export function serverWaitMs(error: ServiceError): number | undefined {
    if (error.nextEligibleAt !== undefined && error.serverTime !== undefined) {
        return Math.max(0, error.nextEligibleAt - error.serverTime)
    }
    return error.retryAfterMs
}

/** Read `Retry-After` as delay seconds or an HTTP date, relative to the local clock. */
export function parseRetryAfterMs(header: string | null, now = Date.now()): number | undefined {
    if (!header) return undefined
    const trimmed = header.trim()
    if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1_000
    const date = Date.parse(trimmed)
    return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isSafeNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}
