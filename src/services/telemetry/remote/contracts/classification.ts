import { type DeliveryDisposition, parseAcknowledgement, parseServiceError, serviceWaitMs } from "./wire"

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
     * A 429 or a pause: this answer stored nothing, but an earlier timed-out
     * attempt may have. Send nothing on this channel until the wait ends, then
     * replay the same batch under the same request ID and bytes.
     */
    | { readonly kind: "wait"; readonly code: string; readonly retryAfterMs?: number }
    /** 413: the server stored nothing; usage drops the batch, logs split it in half. */
    | { readonly kind: "too_large" }
    /** The server will never accept this batch. */
    | { readonly kind: "discard"; readonly code: string }
    | { readonly kind: "stop"; readonly scope: StopScope; readonly code: string }

/**
 * Classify a `/usage` response (usage-contract §15).
 *
 * Only a `UsageAck` confirms the request: `ok:true` with an accepted,
 * duplicate or ignored_version disposition and its `next_eligible_at`. Any
 * other 200 is an unknown result and replays the same bytes, since a commit may
 * have happened and rebuilding would count the same usage twice. 409
 * `request_id_conflict` and every 422 contract error are permanent and
 * dead-letter the request without rebuilding it; 413 means capacity guarding
 * failed and is permanent too.
 */
export function classifyUsageResponse(response: WireResponse, now = Date.now()): DeliveryOutcome {
    const { status } = response
    if (status === 200) {
        const acknowledgement = parseAcknowledgement(response.json)
        return acknowledgement ? { kind: "acknowledged", ...acknowledgement } : { kind: "replay" }
    }
    const error = parseServiceError(response.json, response.retryAfter, now)
    const { code } = error
    const waitMs = serviceWaitMs(error, now)
    const delay = waitMs === undefined ? {} : { retryAfterMs: waitMs }
    if (status === 401) return { kind: "refresh_token" }
    if (status === 403) return stopFor(response, code)
    if (status === 429) return { kind: "wait", code: code ?? EDGE_RATE_LIMITED, ...delay }
    if (status === 413) return { kind: "too_large" }
    if (status === 404 || status === 405) return { kind: "stop", scope: "profile", code: code ?? "endpoint_unavailable" }
    if (status === 408 || status >= 500) return { kind: "replay", ...delay }
    if (status >= 400) return { kind: "discard", code: code ?? `http_${status}` }
    return { kind: "replay", ...delay }
}

/** A JSON 403 from the service refuses one profile; an IP ban or an edge block refuses the machine. */
function stopFor(response: WireResponse, code: string | undefined): { kind: "stop"; scope: StopScope; code: string } {
    if (response.json === undefined) return { kind: "stop", scope: "all", code: EDGE_BLOCKED }
    if (code === IP_BLOCKED) return { kind: "stop", scope: "all", code }
    return { kind: "stop", scope: "profile", code: code ?? "forbidden" }
}
