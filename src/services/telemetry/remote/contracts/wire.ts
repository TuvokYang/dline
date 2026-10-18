/**
 * Wire contract of the Dline OTEL service (`otel.dline.cc`).
 *
 * Parsers validate only the fields the client acts on and ignore everything
 * else, so a server that adds fields does not break delivery. Builders and the
 * aggregate validator mirror the server's rejection rules: a batch the server
 * would refuse with 4xx is a permanent loss once written as an inflight body,
 * so it must be caught before that point.
 */

export const USAGE_SCHEMA_VERSION = 1
export const USAGE_BODY_LIMIT_BYTES = 64 * 1024
export const USAGE_MAX_METRIC_NAMES = 128
export const USAGE_MAX_AGGREGATED_WINDOWS = 10
export const USAGE_WINDOW_MS = 60_000
/** How far the server lets a window end ahead of its own clock. */
export const USAGE_MAX_CLOCK_SKEW_MS = 5 * 60_000

const METRIC_NAME_PATTERN = /^dline\.[a-z0-9][a-z0-9_.-]{0,126}$/
const ATTRIBUTE_VALUE_PATTERN = /^[A-Za-z0-9_.+ -]{1,64}$/
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

export type UsageAttributeKey = "client_version" | "platform" | "architecture" | "vscode_version" | "is_dev"
const USAGE_ATTRIBUTE_KEYS: readonly UsageAttributeKey[] = [
    "client_version",
    "platform",
    "architecture",
    "vscode_version",
    "is_dev",
]

export interface UsageMeasurementWire {
    readonly count: number
    readonly sum: number
    readonly min: number
    readonly max: number
}

export interface UsageAggregateWire {
    readonly schema_version: typeof USAGE_SCHEMA_VERSION
    readonly window_started_at: number
    readonly window_ended_at: number
    readonly aggregation_count: number
    readonly dropped_windows?: number
    readonly counters: Readonly<Record<string, number>>
    readonly measurements?: Readonly<Record<string, UsageMeasurementWire>>
    readonly attributes?: Readonly<Partial<Record<UsageAttributeKey, string | boolean>>>
}

export type UsageAggregateViolation =
    | "schema_version"
    | "window_span"
    | "window_future"
    | "aggregation_count"
    | "dropped_windows"
    | "metric_count"
    | "metric_name"
    | "counter_value"
    | "measurement_bounds"
    | "attribute_key"
    | "attribute_value"

/** Every server rule the aggregate breaks; empty when the server would accept its schema. */
export function validateUsageAggregate(aggregate: UsageAggregateWire, now: number): UsageAggregateViolation[] {
    const violations = new Set<UsageAggregateViolation>()
    const { window_started_at: start, window_ended_at: end, aggregation_count: count } = aggregate
    if (aggregate.schema_version !== USAGE_SCHEMA_VERSION) violations.add("schema_version")
    if (!isSafeNonNegativeInteger(count) || count < 1 || count > USAGE_MAX_AGGREGATED_WINDOWS) violations.add("aggregation_count")
    if (aggregate.dropped_windows !== undefined && !isSafeNonNegativeInteger(aggregate.dropped_windows)) {
        violations.add("dropped_windows")
    }
    if (!isSafeNonNegativeInteger(start) || !isSafeNonNegativeInteger(end) || start > end) violations.add("window_span")
    else if (end - start > count * USAGE_WINDOW_MS + USAGE_WINDOW_MS) violations.add("window_span")
    if (end > now + USAGE_MAX_CLOCK_SKEW_MS) violations.add("window_future")

    const counters = Object.entries(aggregate.counters)
    const measurements = Object.entries(aggregate.measurements ?? {})
    const names = [...counters, ...measurements].map(([name]) => name)
    if (names.length === 0 || names.length > USAGE_MAX_METRIC_NAMES || new Set(names).size !== names.length) {
        violations.add("metric_count")
    }
    if (names.some((name) => !METRIC_NAME_PATTERN.test(name))) violations.add("metric_name")
    if (counters.some(([, value]) => !isSafeNonNegativeInteger(value))) violations.add("counter_value")
    if (measurements.some(([, value]) => !isConsistentMeasurement(value))) violations.add("measurement_bounds")

    for (const [key, value] of Object.entries(aggregate.attributes ?? {})) {
        if (!USAGE_ATTRIBUTE_KEYS.includes(key as UsageAttributeKey)) violations.add("attribute_key")
        else if (
            key === "is_dev" ? typeof value !== "boolean" : typeof value !== "string" || !ATTRIBUTE_VALUE_PATTERN.test(value)
        ) {
            violations.add("attribute_value")
        }
    }
    return [...violations]
}

function isConsistentMeasurement({ count, sum, min, max }: UsageMeasurementWire): boolean {
    if (!isSafeNonNegativeInteger(count) || count < 1) return false
    if (![sum, min, max].every((value) => Number.isFinite(value) && value >= 0)) return false
    return min <= max && min * count <= sum && sum <= max * count
}

/** A confirmed usage batch. */
export interface UsageAcknowledgement {
    readonly duplicate: boolean
}

export function parseUsageAcknowledgement(body: unknown): UsageAcknowledgement | undefined {
    if (!isRecord(body) || body.ok !== true) return undefined
    if (body.disposition === "accepted") return { duplicate: false }
    if (body.disposition === "duplicate") return { duplicate: true }
    return undefined
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
