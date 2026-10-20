import { type DeliveryDisposition, type DeviceGrant, parseAcknowledgement, parseDeviceGrant, parseServiceError } from "./wire"

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
/** Code used for an edge 429, which carries neither a body nor a `Retry-After`. */
export const EDGE_RATE_LIMITED = "edge_rate_limited"
const IP_BLOCKED = "ip_blocked"

export type DeliveryOutcome =
    /**
     * The server holds the batch, recorded it as a duplicate, or ignores this
     * client version: drop it and wait for the gate the server named.
     */
    | { readonly kind: "acknowledged"; readonly disposition: DeliveryDisposition; readonly nextEligibleAt?: number }
    /** The server may hold the batch: resend the same request ID with the same bytes. */
    | { readonly kind: "replay"; readonly retryAfterMs?: number }
    /** The token is no longer accepted: exchange again, then send the same bytes once more. */
    | { readonly kind: "refresh_token" }
    /**
     * A 429 or a pause: the server stored nothing. Send nothing on this channel
     * until the wait ends, then rebuild the batch under a new request ID.
     */
    | { readonly kind: "wait"; readonly code: string; readonly retryAfterMs?: number }
    /** 413: the server stored nothing; usage drops the batch, logs split it in half. */
    | { readonly kind: "too_large" }
    /** The server will never accept this batch. */
    | { readonly kind: "discard"; readonly code: string }
    | { readonly kind: "stop"; readonly scope: StopScope; readonly code: string }

/**
 * Classify a `/v1/usage` or `/v1/logs` response (otel contract v2 §1.5).
 *
 * The server checks idempotency before anything else, so replaying identical
 * bytes is always safe; rebuilding a batch is only safe when the server
 * certainly stored nothing. A 5xx or an unconfirmed 200 may follow a commit, so
 * it replays rather than rebuilds, which would count the same usage twice.
 */
export function classifyDeliveryResponse(response: WireResponse): DeliveryOutcome {
    const { status } = response
    if (status === 200) {
        const acknowledgement = parseAcknowledgement(response.json)
        if (!acknowledgement) return { kind: "replay" }
        return {
            kind: "acknowledged",
            disposition: acknowledgement.disposition,
            ...(acknowledgement.nextEligibleAt === undefined ? {} : { nextEligibleAt: acknowledgement.nextEligibleAt }),
        }
    }
    const error = parseServiceError(response.json, response.retryAfter)
    const delay = error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }
    if (status === 401) return { kind: "refresh_token" }
    if (status === 403) return stopFor(response, error.code)
    if (status === 429) return { kind: "wait", code: error.code ?? EDGE_RATE_LIMITED, ...delay }
    if (status === 413) return { kind: "too_large" }
    if (status === 404 || status === 405) return { kind: "stop", scope: "profile", code: error.code ?? "endpoint_unavailable" }
    if (status === 408 || status >= 500) return { kind: "replay", ...delay }
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
