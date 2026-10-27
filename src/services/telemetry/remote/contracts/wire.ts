/**
 * Wire contract of the Dline OTEL service (`otel.dline.cc`): acknowledgements
 * and error bodies. The device grant lives in `deviceGrant.ts` and the usage
 * body in `usageBody.ts`.
 *
 * Parsers validate only the fields the client acts on and ignore everything
 * else, so a server that adds fields does not break delivery.
 */

export type RemoteProfile = "usage" | "production" | "development"

/**
 * How the service settled a request it confirmed.
 *
 * `accepted` stored the batch and `duplicate` recognised the same request ID
 * and bytes as an earlier attempt. `ignored_version` confirms a Usage request
 * without a business write (usage-contract §15); the logs channel does not
 * treat it as a confirmation, so there a batch is replayed instead of dropped.
 */
export type DeliveryDisposition = "accepted" | "duplicate" | "ignored_version"
const DELIVERY_DISPOSITIONS: readonly DeliveryDisposition[] = ["accepted", "duplicate"]

/** A confirmed batch and the earliest time, server epoch milliseconds, the next new batch may follow. */
export interface DeliveryAcknowledgement {
    readonly disposition: DeliveryDisposition
    readonly nextEligibleAt?: number
}

/** `200 ok:true` with a known disposition; anything else is not a confirmation. */
export function parseAcknowledgement(body: unknown): DeliveryAcknowledgement | undefined {
    if (!isRecord(body) || body.ok !== true) return undefined
    const disposition = body.disposition
    if (!DELIVERY_DISPOSITIONS.includes(disposition as DeliveryDisposition)) return undefined
    const next = body.next_eligible_at
    return {
        disposition: disposition as DeliveryDisposition,
        ...(isSafeNonNegativeInteger(next) ? { nextEligibleAt: next } : {}),
    }
}

const USAGE_DISPOSITIONS = ["accepted", "duplicate", "ignored_version", "rejected"] as const
const USAGE_RESPONSE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u

/** A `/usage` response body (usage-contract §15): flat, without the `ok` envelope of the other endpoints. */
export interface UsageResponseBody {
    readonly disposition: (typeof USAGE_DISPOSITIONS)[number]
    readonly code?: string
    /** Server epoch milliseconds. */
    readonly nextEligibleAt?: number
}

/** The fields of a `/usage` response the client acts on; an unknown disposition is not a response body. */
export function parseUsageResponseBody(body: unknown): UsageResponseBody | undefined {
    if (!isRecord(body)) return undefined
    const disposition = USAGE_DISPOSITIONS.find((value) => value === body.disposition)
    if (!disposition) return undefined
    const { code, next_eligible_at: next } = body
    return {
        disposition,
        ...(typeof code === "string" && USAGE_RESPONSE_CODE_PATTERN.test(code) ? { code } : {}),
        ...(isSafeNonNegativeInteger(next) ? { nextEligibleAt: next } : {}),
    }
}

/** The machine-readable part of an error body; some error bodies carry no message at all. */
export interface ServiceError {
    readonly code?: string
    readonly retryAfterMs?: number
}

export function parseServiceError(body: unknown, retryAfterHeader: string | null, now = Date.now()): ServiceError {
    const error = isRecord(body) && isRecord(body.error) ? body.error : undefined
    const code = typeof error?.code === "string" && error.code.length > 0 ? error.code : undefined
    const bodyDelay = isRecord(body) && isSafeNonNegativeInteger(body.retry_after_ms) ? body.retry_after_ms : undefined
    const retryAfterMs = bodyDelay ?? parseRetryAfterMs(retryAfterHeader, now)
    return { ...(code ? { code } : {}), ...(retryAfterMs === undefined ? {} : { retryAfterMs }) }
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
