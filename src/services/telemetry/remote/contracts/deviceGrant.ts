import type { RemoteProfile } from "./wire"

export const USAGE_GRANT_SCHEMA_VERSION = 4
export const USAGE_GRANT_CONTRACT_VERSION = 4

const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_DEVICE_ID_LENGTH = 128
const SCOPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/
const MAX_SCOPES = 16
const REMOTE_PROFILES: readonly RemoteProfile[] = ["usage", "production", "development"]

/** Client-enforced schema 4 maxima. A service grant may tighten but never widen them. */
export const USAGE_GRANT_HARD_LIMITS = {
    maxBodyBytes: 65_536,
    maxBuckets: 8,
    maxFacts: 32,
    maxToolRows: 384,
    maxWriteRows: 486,
    eventWindowMs: 600_000,
} as const

/** Complete schema capability required before the client may construct a schema 4 Usage request. */
export interface UsageGrantContract {
    readonly schemaVersion: typeof USAGE_GRANT_SCHEMA_VERSION
    readonly contractVersion: typeof USAGE_GRANT_CONTRACT_VERSION
    readonly maxBodyBytes: number
    readonly maxBuckets: number
    readonly maxFacts: number
    readonly maxToolRows: number
    readonly maxWriteRows: number
    readonly eventWindowMs: number
    readonly defaultIntervalMs: number
    readonly newBatchJitterMaxMs: number
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
    if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > MAX_DEVICE_ID_LENGTH) return undefined
    if (!REMOTE_PROFILES.includes(profile as RemoteProfile)) return undefined
    const scopes = parseScopes(rawScopes)
    if (!scopes) return undefined
    const usageContract = parseUsageGrantContract(rawUsageContract)
    if (!usageContract || !scopes.includes("usage")) return undefined
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
        default_interval_ms: defaultIntervalMs,
        new_batch_jitter_max_ms: newBatchJitterMaxMs,
    } = value
    if (schemaVersion !== USAGE_GRANT_SCHEMA_VERSION || contractVersion !== USAGE_GRANT_CONTRACT_VERSION) return undefined
    if (!isBoundedPositiveInteger(maxBodyBytes, USAGE_GRANT_HARD_LIMITS.maxBodyBytes)) return undefined
    if (!isBoundedPositiveInteger(maxBuckets, USAGE_GRANT_HARD_LIMITS.maxBuckets)) return undefined
    if (!isBoundedPositiveInteger(maxFacts, USAGE_GRANT_HARD_LIMITS.maxFacts)) return undefined
    if (!isBoundedPositiveInteger(maxToolRows, USAGE_GRANT_HARD_LIMITS.maxToolRows)) return undefined
    if (!isBoundedPositiveInteger(maxWriteRows, USAGE_GRANT_HARD_LIMITS.maxWriteRows)) return undefined
    if (!isBoundedPositiveInteger(eventWindowMs, USAGE_GRANT_HARD_LIMITS.eventWindowMs)) return undefined
    if (!isSafePositiveInteger(defaultIntervalMs)) return undefined
    if (!isSafeNonNegativeInteger(newBatchJitterMaxMs) || newBatchJitterMaxMs > defaultIntervalMs) return undefined
    return {
        schemaVersion,
        contractVersion,
        maxBodyBytes,
        maxBuckets,
        maxFacts,
        maxToolRows,
        maxWriteRows,
        eventWindowMs,
        defaultIntervalMs,
        newBatchJitterMaxMs,
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
        default_interval_ms: contract.defaultIntervalMs,
        new_batch_jitter_max_ms: contract.newBatchJitterMaxMs,
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
