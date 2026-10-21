/**
 * Wire contract of the Dline OTEL service (`otel.dline.cc`): device exchange,
 * acknowledgements and error bodies. The usage body lives in `usageBody.ts`.
 *
 * Parsers validate only the fields the client acts on and ignore everything
 * else, so a server that adds fields does not break delivery.
 */

const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
const CLIENT_FIELD_MAX_LENGTH = 64
const UNKNOWN_CLIENT_FIELD = "unknown"

export type RemoteProfile = "usage" | "production" | "development"
const REMOTE_PROFILES: readonly RemoteProfile[] = ["usage", "production", "development"]

export interface DeviceExchangeRequest {
    readonly device_secret: string
    readonly requested_profile: RemoteProfile
    readonly client_version: string
    readonly platform: string
}

/** Build an exchange body the server accepts. A malformed secret is a local bug, not a request to send. */
export function buildDeviceExchangeRequest(input: {
    readonly deviceSecret: string
    readonly profile: RemoteProfile
    readonly clientVersion: string
    readonly platform: string
}): DeviceExchangeRequest {
    if (!BASE64URL_43_PATTERN.test(input.deviceSecret)) {
        throw new Error("Device secret must be 32 random bytes encoded as base64url")
    }
    return {
        device_secret: input.deviceSecret,
        requested_profile: input.profile,
        client_version: boundClientField(input.clientVersion),
        platform: boundClientField(input.platform),
    }
}

function boundClientField(value: string): string {
    const trimmed = value.trim().slice(0, CLIENT_FIELD_MAX_LENGTH)
    return trimmed.length > 0 ? trimmed : UNKNOWN_CLIENT_FIELD
}

/** The part of a device exchange response the client acts on. */
export interface DeviceGrant {
    readonly accessToken: string
    readonly deviceId: string
    readonly profile: RemoteProfile
    /** Server epoch milliseconds. */
    readonly expiresAt: number
    /** The server's preferred usage cadence, when it sent one. */
    readonly metricExportIntervalMs?: number
}

export function parseDeviceGrant(body: unknown): DeviceGrant | undefined {
    if (!isRecord(body) || body.ok !== true) return undefined
    const { access_token: accessToken, device_id: deviceId, profile, expires_at: expiresAt } = body
    if (typeof accessToken !== "string" || !BASE64URL_43_PATTERN.test(accessToken)) return undefined
    if (typeof deviceId !== "string" || deviceId.length === 0) return undefined
    if (!REMOTE_PROFILES.includes(profile as RemoteProfile)) return undefined
    if (!isSafeNonNegativeInteger(expiresAt)) return undefined
    const interval = isRecord(body.capture_policy) ? body.capture_policy.metric_export_interval_ms : undefined
    return {
        accessToken,
        deviceId,
        profile: profile as RemoteProfile,
        expiresAt,
        ...(isSafeNonNegativeInteger(interval) && interval > 0 ? { metricExportIntervalMs: interval } : {}),
    }
}

/**
 * How the service settled a batch it actually stored.
 *
 * This is the complete confirmation set: `accepted` stored the batch and
 * `duplicate` recognised the same request ID and bytes as an earlier attempt.
 * Any other disposition — including a version the service chose to ignore — is
 * *not* a confirmation, so the batch is treated as unknown and replayed under
 * the same request ID instead of being dropped as if it had been stored.
 */
export type DeliveryDisposition = "accepted" | "duplicate"
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
