const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
const AUTHORIZATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/
const SCOPE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/
const MAX_SCOPES = 16

export interface IssueGrantRateLimits {
    readonly maxRequestBytes: number
    readonly maxRequests: number
    readonly maxRecords: number
}

/** Complete issue-only credential generation published after recoverable exchange. */
export interface AtomicIssueGrant {
    readonly accessToken: string
    readonly profile: "issue_diagnostic"
    readonly scopes: readonly string[]
    readonly authorizationId: string
    readonly authorizationRevision: number
    readonly expiresAt: number
    readonly captureExpiresAt: number
    readonly rateLimits: IssueGrantRateLimits
}

export function parseAtomicIssueGrant(value: unknown): AtomicIssueGrant | undefined {
    if (!isRecord(value) || value.ok !== true || value.profile !== "issue_diagnostic") return undefined
    const accessToken = value.access_token
    const authorizationId = value.authorization_id
    const authorizationRevision = value.authorization_revision
    const expiresAt = value.expires_at
    const captureExpiresAt = value.capture_expires_at
    const scopes = parseScopes(value.scopes)
    const rateLimits = parseRateLimits(value.rate_limits)
    if (typeof accessToken !== "string" || !BASE64URL_43_PATTERN.test(accessToken)) return undefined
    if (typeof authorizationId !== "string" || !AUTHORIZATION_ID_PATTERN.test(authorizationId)) return undefined
    if (!isPositiveInteger(authorizationRevision) || !isTimestamp(expiresAt) || !isTimestamp(captureExpiresAt)) return undefined
    if (expiresAt > captureExpiresAt || !scopes || !rateLimits) return undefined
    return {
        accessToken,
        profile: "issue_diagnostic",
        scopes,
        authorizationId,
        authorizationRevision,
        expiresAt,
        captureExpiresAt,
        rateLimits,
    }
}

export function validateAtomicIssueGrant(grant: AtomicIssueGrant): AtomicIssueGrant {
    const parsed = parseAtomicIssueGrant({ ok: true, ...serializeAtomicIssueGrant(grant) })
    if (!parsed) throw new Error("Refusing to publish an invalid issue grant")
    return parsed
}

export function serializeAtomicIssueGrant(grant: AtomicIssueGrant): Record<string, unknown> {
    return {
        access_token: grant.accessToken,
        profile: grant.profile,
        scopes: [...grant.scopes],
        authorization_id: grant.authorizationId,
        authorization_revision: grant.authorizationRevision,
        expires_at: grant.expiresAt,
        capture_expires_at: grant.captureExpiresAt,
        rate_limits: {
            max_request_bytes: grant.rateLimits.maxRequestBytes,
            max_requests: grant.rateLimits.maxRequests,
            max_records: grant.rateLimits.maxRecords,
        },
    }
}

export function sameAtomicIssueGrant(left: AtomicIssueGrant, right: AtomicIssueGrant): boolean {
    return JSON.stringify(serializeAtomicIssueGrant(left)) === JSON.stringify(serializeAtomicIssueGrant(right))
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

function parseRateLimits(value: unknown): IssueGrantRateLimits | undefined {
    if (!isRecord(value)) return undefined
    const maxRequestBytes = value.byte_capacity ?? value.max_request_bytes
    const maxRequests = value.authorization_requests ?? value.max_requests
    const maxRecords = value.authorization_records ?? value.max_records
    if (!isPositiveInteger(maxRequestBytes) || !isNonNegativeInteger(maxRequests) || !isNonNegativeInteger(maxRecords)) {
        return undefined
    }
    return { maxRequestBytes, maxRequests, maxRecords }
}

function isTimestamp(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isPositiveInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

function isNonNegativeInteger(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
