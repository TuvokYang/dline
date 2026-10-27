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
 * The failure envelope `{ok: false, error: {code, path?}}`. `retry_after_ms`
 * and `next_eligible_at` sit at the top level and appear only where they apply;
 * some edge answers carry no body at all.
 */
export interface ServiceError {
    readonly code?: string
    /** The body's `retry_after_ms`, else `Retry-After` relative to the local clock. */
    readonly retryAfterMs?: number
    /** Server epoch milliseconds. */
    readonly nextEligibleAt?: number
}

export function parseServiceError(body: unknown, retryAfterHeader: string | null, now = Date.now()): ServiceError {
    const envelope: Record<string, unknown> = isRecord(body) ? body : {}
    const error = isRecord(envelope.error) ? envelope.error : undefined
    const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : undefined
    const delay = envelope.retry_after_ms
    const retryAfterMs = isSafeNonNegativeInteger(delay) ? delay : parseRetryAfterMs(retryAfterHeader, now)
    const next = envelope.next_eligible_at
    return {
        ...(code ? { code } : {}),
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        ...(isSafeNonNegativeInteger(next) ? { nextEligibleAt: next } : {}),
    }
}

/** How long a failure asks the client to wait: its `next_eligible_at` gate wins over any delay. */
export function serviceWaitMs(error: ServiceError, now: number): number | undefined {
    return error.nextEligibleAt === undefined ? error.retryAfterMs : Math.max(0, error.nextEligibleAt - now)
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
