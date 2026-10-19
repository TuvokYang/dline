import { type DeviceGrant, parseDeviceGrant, parseServiceError, parseUsageAcknowledgement } from "./wire"

/**
 * What the delivery layer needs from an HTTP response.
 *
 * `json` is the parsed body, or undefined when the body was not JSON: an edge
 * block page, a proxy error, or a truncated body all land there, and the
 * classifiers treat them by status alone.
 */
export interface WireResponse {
    readonly status: number
    readonly json: unknown
    readonly retryAfter: string | null
}

/** `profile` stops the stream that was refused; `all` stops every remote profile and forbids working around it. */
export type StopScope = "profile" | "all"

/** Code used when the edge, not the service, refused the request. */
export const EDGE_BLOCKED = "edge_blocked"
const IP_BLOCKED = "ip_blocked"

export type UsageOutcome =
    /** The server holds the batch: drop the inflight. */
    | { readonly kind: "acknowledged"; readonly duplicate: boolean }
    /** The server may hold the batch: resend the same request ID with the same bytes. */
    | { readonly kind: "replay"; readonly retryAfterMs?: number }
    /** The token is no longer accepted: exchange again, then replay once. */
    | { readonly kind: "refresh_token" }
    /** The server stored nothing and asks to wait: merge the batch into a later window under a new request ID. */
    | { readonly kind: "defer"; readonly code: string; readonly retryAfterMs?: number }
    /** The server will never accept this batch. */
    | { readonly kind: "discard"; readonly code: string }
    | { readonly kind: "stop"; readonly scope: StopScope; readonly code: string }

/**
 * Classify a `/v1/usage` response.
 *
 * The server checks idempotency before anything else, so replaying identical
 * bytes is always safe; merging is only safe when the server certainly stored
 * nothing. A 5xx or an unconfirmed 200 may follow a commit, so it replays
 * rather than merges, which would count the same usage twice.
 */
export function classifyUsageResponse(response: WireResponse): UsageOutcome {
    const { status } = response
    if (status === 200) {
        const acknowledgement = parseUsageAcknowledgement(response.json)
        return acknowledgement ? { kind: "acknowledged", duplicate: acknowledgement.duplicate } : { kind: "replay" }
    }
    const error = parseServiceError(response.json, response.retryAfter)
    const delay = error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }
    if (status === 401) return { kind: "refresh_token" }
    if (status === 403) return stopFor(response, error.code)
    if (status === 429) return { kind: "defer", code: error.code ?? "rate_limited", ...delay }
    if (status === 404 || status === 405) return { kind: "stop", scope: "profile", code: error.code ?? "endpoint_unavailable" }
    if (status === 408 || status >= 500) return { kind: "replay", ...delay }
    if (status >= 400) return { kind: "discard", code: error.code ?? `http_${status}` }
    return { kind: "replay", ...delay }
}

export type DiagnosticOutcome =
    /** The server holds the batch, possibly minus records it rejected: drop the inflight. */
    | { readonly kind: "acknowledged" }
    /** The server may not hold the batch: send the same request ID with the same bytes later. */
    | { readonly kind: "replay"; readonly retryAfterMs?: number }
    | { readonly kind: "refresh_token" }
    /** The server will never accept this batch. */
    | { readonly kind: "discard"; readonly code: string }
    | { readonly kind: "stop"; readonly scope: StopScope; readonly code: string }

/**
 * Classify a `/v1/logs` response.
 *
 * Diagnostics are not counted, so a rate limit simply waits and sends the same
 * bytes again; nothing is merged. A 200 that rejected some records is still an
 * acknowledgement: resending would be refused the same way.
 */
export function classifyDiagnosticResponse(response: WireResponse): DiagnosticOutcome {
    const { status } = response
    if (status === 200) {
        const acknowledged = (response.json as { ok?: unknown } | undefined)?.ok === true
        return acknowledged ? { kind: "acknowledged" } : { kind: "replay" }
    }
    const error = parseServiceError(response.json, response.retryAfter)
    const delay = error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }
    if (status === 401) return { kind: "refresh_token" }
    if (status === 403) return stopFor(response, error.code)
    if (status === 429 || status === 408 || status >= 500) return { kind: "replay", ...delay }
    if (status === 404 || status === 405) return { kind: "stop", scope: "profile", code: error.code ?? "endpoint_unavailable" }
    if (status >= 400) return { kind: "discard", code: error.code ?? `http_${status}` }
    return { kind: "replay", ...delay }
}

export type ExchangeOutcome =
    | { readonly kind: "granted"; readonly grant: DeviceGrant }
    /** Try again later; every instance shares this delay so the enrollment budget is not spent in a loop. */
    | { readonly kind: "backoff"; readonly code: string; readonly retryAfterMs?: number }
    /** The server revoked this device credential: forget it and wait for an explicit identity reset. */
    | { readonly kind: "reset_credential"; readonly code: string }
    | { readonly kind: "stop"; readonly scope: StopScope; readonly code: string }

const REVOKED_CREDENTIAL_CODES = new Set(["device_revoked", "device_credential_revoked"])

/** Classify a `/v1/auth/device/exchange` response. */
export function classifyExchangeResponse(response: WireResponse): ExchangeOutcome {
    const { status } = response
    if (status === 200) {
        const grant = parseDeviceGrant(response.json)
        return grant ? { kind: "granted", grant } : { kind: "backoff", code: "malformed_grant" }
    }
    const error = parseServiceError(response.json, response.retryAfter)
    const delay = error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }
    if (status === 403 && error.code && REVOKED_CREDENTIAL_CODES.has(error.code)) {
        return { kind: "reset_credential", code: error.code }
    }
    if (status === 403) return stopFor(response, error.code)
    if (status === 408 || status === 429 || status >= 500)
        return { kind: "backoff", code: error.code ?? `http_${status}`, ...delay }
    return { kind: "stop", scope: "profile", code: error.code ?? `http_${status}` }
}

/** A JSON 403 from the service refuses one profile; an IP ban or an edge block refuses the machine. */
function stopFor(response: WireResponse, code: string | undefined): { kind: "stop"; scope: StopScope; code: string } {
    if (response.json === undefined) return { kind: "stop", scope: "all", code: EDGE_BLOCKED }
    if (code === IP_BLOCKED) return { kind: "stop", scope: "all", code }
    return { kind: "stop", scope: "profile", code: code ?? "forbidden" }
}
