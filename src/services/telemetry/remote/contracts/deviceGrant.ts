import {
    USAGE_CONTRACT_REVISION,
    USAGE_DURATION_BUCKET_THRESHOLD_MS,
    USAGE_EVENT_WINDOW_MS,
    USAGE_SCHEMA_VERSION,
} from "./usageBodySchema"
import type { RemoteProfile } from "./wire"

const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
/** Server-derived pseudonymous device identity (telemetry-exchange-flow §4); the client never computes it. */
const DEVICE_ID_PATTERN = /^dev_[0-9a-f]{32}$/
const SCOPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/
const MAX_SCOPES = 16
const REMOTE_PROFILES: readonly RemoteProfile[] = ["usage", "production", "development"]

/**
 * Profiles this client requests from `/auth/device/grant`: `usage` for `/usage`,
 * `production` for production OTLP and the issue exchange. The grant endpoint is
 * the only device-credential issuer (telemetry-exchange-flow §4).
 */
export type DeviceGrantProfile = Extract<RemoteProfile, "usage" | "production">

export function isDeviceId(value: unknown): value is string {
    return typeof value === "string" && DEVICE_ID_PATTERN.test(value)
}

/** Client-enforced schema 5 maxima. A service grant may tighten but never widen them. */
export const USAGE_GRANT_HARD_LIMITS = {
    maxBodyBytes: 65_536,
    maxBuckets: 8,
    maxFacts: 32,
    maxToolRows: 384,
    maxWriteRows: 486,
    eventWindowMs: USAGE_EVENT_WINDOW_MS,
    durationBucketThresholdMs: USAGE_DURATION_BUCKET_THRESHOLD_MS,
    maxRequestReplayAgeMs: 7 * 24 * 60 * 60_000,
} as const

/** Complete schema capability required before the client may construct a schema 5 Usage request. */
export interface UsageGrantContract {
    readonly schemaVersion: typeof USAGE_SCHEMA_VERSION
    /** At least {@link USAGE_CONTRACT_REVISION}. */
    readonly contractVersion: number
    readonly maxBodyBytes: number
    readonly maxBuckets: number
    readonly maxFacts: number
    readonly maxToolRows: number
    readonly maxWriteRows: number
    /** Echo of the fixed schema 5 constant; any other value refuses the grant. */
    readonly eventWindowMs: number
    /** Echo of the fixed schema 5 constant; any other value refuses the grant. */
    readonly durationBucketThresholdMs: number
    readonly defaultIntervalMs: number
    readonly newBatchJitterMaxMs: number
    /** How long an unknown-outcome request is replayed with identical bytes before it is dead-lettered. */
    readonly maxRequestReplayAgeMs: number
}

/**
 * One credential generation published as a unit.
 *
 * The bearer token alone is not a schema capability. Callers may use this grant
 * only while every field remains available from the same repository generation.
 */
export interface AtomicDeviceGrant {
    readonly accessToken: string
    readonly deviceId: string
    readonly profile: RemoteProfile
    readonly scopes: readonly string[]
    readonly expiresAt: number
    readonly usageContract: UsageGrantContract
}

/** Parse the snake-case service/persistence representation without trusting partial capability state. */
export function parseAtomicDeviceGrant(value: unknown): AtomicDeviceGrant | undefined {
    if (!isRecord(value)) return undefined
    const {
        access_token: accessToken,
        device_id: deviceId,
        profile,
        scopes: rawScopes,
        expires_at: expiresAt,
        usage_contract: rawUsageContract,
    } = value
    if (typeof accessToken !== "string" || !BASE64URL_43_PATTERN.test(accessToken)) return undefined
    if (!isDeviceId(deviceId)) return undefined
    if (!REMOTE_PROFILES.includes(profile as RemoteProfile)) return undefined
    const scopes = parseScopes(rawScopes)
    if (!scopes) return undefined
    const usageContract = parseUsageGrantContract(rawUsageContract)
    if (!usageContract) return undefined
    // A usage credential that may not write `/usage` is no Usage capability; other profiles carry their own scopes.
    if (profile === "usage" && !scopes.includes("usage")) return undefined
    if (!isSafeNonNegativeInteger(expiresAt)) return undefined
    return {
        accessToken,
        deviceId,
        profile: profile as RemoteProfile,
        scopes,
        expiresAt,
        usageContract,
    }
}

/** Validate a domain grant and return a detached canonical copy safe to persist. */
export function validateAtomicDeviceGrant(grant: AtomicDeviceGrant): AtomicDeviceGrant {
    const parsed = parseAtomicDeviceGrant(serializeAtomicDeviceGrantUnchecked(grant))
    if (!parsed) throw new Error("Refusing to publish an invalid device grant")
    return parsed
}

export function serializeAtomicDeviceGrant(grant: AtomicDeviceGrant): Record<string, unknown> {
    const validated = validateAtomicDeviceGrant(grant)
    return serializeAtomicDeviceGrantUnchecked(validated)
}

export function sameAtomicDeviceGrant(left: AtomicDeviceGrant, right: AtomicDeviceGrant): boolean {
    return JSON.stringify(serializeAtomicDeviceGrant(left)) === JSON.stringify(serializeAtomicDeviceGrant(right))
}

export function parseUsageGrantContract(value: unknown): UsageGrantContract | undefined {
    if (!isRecord(value)) return undefined
    const {
        schema_version: schemaVersion,
        contract_version: contractVersion,
        max_body_bytes: maxBodyBytes,
        max_buckets: maxBuckets,
        max_facts: maxFacts,
        max_tool_rows: maxToolRows,
        max_write_rows: maxWriteRows,
        event_window_ms: eventWindowMs,
        duration_bucket_threshold_ms: durationBucketThresholdMs,
        default_interval_ms: defaultIntervalMs,
        new_batch_jitter_max_ms: newBatchJitterMaxMs,
        max_request_replay_age_ms: maxRequestReplayAgeMs,
    } = value
    if (schemaVersion !== USAGE_SCHEMA_VERSION) return undefined
    if (!isSafePositiveInteger(contractVersion) || contractVersion < USAGE_CONTRACT_REVISION) return undefined
    if (!isBoundedPositiveInteger(maxBodyBytes, USAGE_GRANT_HARD_LIMITS.maxBodyBytes)) return undefined
    if (!isBoundedPositiveInteger(maxBuckets, USAGE_GRANT_HARD_LIMITS.maxBuckets)) return undefined
    if (!isBoundedPositiveInteger(maxFacts, USAGE_GRANT_HARD_LIMITS.maxFacts)) return undefined
    if (!isBoundedPositiveInteger(maxToolRows, USAGE_GRANT_HARD_LIMITS.maxToolRows)) return undefined
    if (!isBoundedPositiveInteger(maxWriteRows, USAGE_GRANT_HARD_LIMITS.maxWriteRows)) return undefined
    // Fixed schema 5 partition constants: the grant echoes them for verification and never changes them.
    if (eventWindowMs !== USAGE_GRANT_HARD_LIMITS.eventWindowMs) return undefined
    if (durationBucketThresholdMs !== USAGE_GRANT_HARD_LIMITS.durationBucketThresholdMs) return undefined
    if (!isSafePositiveInteger(defaultIntervalMs)) return undefined
    if (!isSafeNonNegativeInteger(newBatchJitterMaxMs) || newBatchJitterMaxMs > defaultIntervalMs) return undefined
    if (!isBoundedPositiveInteger(maxRequestReplayAgeMs, USAGE_GRANT_HARD_LIMITS.maxRequestReplayAgeMs)) return undefined
    return {
        schemaVersion,
        contractVersion,
        maxBodyBytes,
        maxBuckets,
        maxFacts,
        maxToolRows,
        maxWriteRows,
        eventWindowMs,
        durationBucketThresholdMs,
        defaultIntervalMs,
        newBatchJitterMaxMs,
        maxRequestReplayAgeMs,
    }
}

export function serializeUsageGrantContract(contract: UsageGrantContract): Record<string, unknown> {
    return {
        schema_version: contract.schemaVersion,
        contract_version: contract.contractVersion,
        max_body_bytes: contract.maxBodyBytes,
        max_buckets: contract.maxBuckets,
        max_facts: contract.maxFacts,
        max_tool_rows: contract.maxToolRows,
        max_write_rows: contract.maxWriteRows,
        event_window_ms: contract.eventWindowMs,
        duration_bucket_threshold_ms: contract.durationBucketThresholdMs,
        default_interval_ms: contract.defaultIntervalMs,
        new_batch_jitter_max_ms: contract.newBatchJitterMaxMs,
        max_request_replay_age_ms: contract.maxRequestReplayAgeMs,
    }
}

function serializeAtomicDeviceGrantUnchecked(grant: AtomicDeviceGrant): Record<string, unknown> {
    return {
        access_token: grant.accessToken,
        device_id: grant.deviceId,
        profile: grant.profile,
        scopes: [...grant.scopes],
        expires_at: grant.expiresAt,
        usage_contract: serializeUsageGrantContract(grant.usageContract),
    }
}

function parseScopes(value: unknown): readonly string[] | undefined {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SCOPES) return undefined
    const scopes: string[] = []
    const seen = new Set<string>()
    for (const scope of value) {
        if (typeof scope !== "string" || !SCOPE_PATTERN.test(scope) || seen.has(scope)) return undefined
        seen.add(scope)
        scopes.push(scope)
    }
    return scopes
}

function isBoundedPositiveInteger(value: unknown, maximum: number): value is number {
    return isSafePositiveInteger(value) && value <= maximum
}

function isSafePositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isSafeNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
