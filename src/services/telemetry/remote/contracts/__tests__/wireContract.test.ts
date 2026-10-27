import { describe, expect, it } from "vitest"
import { classifyDeliveryResponse, type WireResponse } from "../classification"
import { parseRetryAfterMs } from "../wire"

// Response bodies below follow the service's documented wire format.
const NOW = 1_800_000_000_000

const json = (status: number, body: unknown, retryAfter: string | null = null): WireResponse => ({
    status,
    json: body,
    retryAfter,
})
const edge = (status: number): WireResponse => ({ status, json: undefined, retryAfter: null })
const failure = (status: number, code: string, extra: Record<string, unknown> = {}) =>
    json(status, { ok: false, request_id: "r", retryable: status >= 500, error: { code, message: "x" }, ...extra })

describe("usage and logs response classification (contract v2.1 §1.5)", () => {
    it.each([
        "accepted",
        "duplicate",
    ] as const)("acknowledges a 200 ok:true %s and carries the gate the service named", (disposition) => {
        const response = json(200, { ok: true, disposition, next_eligible_at: NOW + 600_000, dropped_fields: 2 })

        expect(classifyDeliveryResponse(response)).toEqual({
            kind: "acknowledged",
            disposition,
            nextEligibleAt: NOW + 600_000,
        })
    })

    it("does not treat a disposition outside the confirmation set as a stored batch", () => {
        // `accepted` and `duplicate` are the whole confirmation set. A version the
        // service chose not to store must not be dropped as if it had been: the batch
        // is replayed under the same request ID instead.
        const ignored = json(200, { ok: true, disposition: "ignored_version", next_eligible_at: NOW + 600_000 })

        expect(classifyDeliveryResponse(ignored).kind).toBe("replay")
    })

    it("acknowledges the logs answer that counted records over the service's daily limit", () => {
        const response = json(200, { ok: true, disposition: "accepted", accepted: 3, discarded: 2, next_eligible_at: NOW })

        expect(classifyDeliveryResponse(response)).toMatchObject({ kind: "acknowledged", disposition: "accepted" })
    })

    it("replays the same bytes when a 200 does not confirm the batch", () => {
        expect(classifyDeliveryResponse(json(200, { ok: true })).kind).toBe("replay")
        expect(classifyDeliveryResponse(json(200, { ok: true, disposition: "stored" })).kind).toBe("replay")
        expect(classifyDeliveryResponse(json(200, { ok: false, disposition: "accepted" })).kind).toBe("replay")
        expect(classifyDeliveryResponse(edge(200)).kind).toBe("replay")
    })

    it.each([
        ["rate_limited", 4_000],
        ["quota_protected", 3_600_000],
        ["telemetry_paused", 7_200_000],
    ])("waits on a 429 %s for the retry_after_ms the body names", (code, retryAfterMs) => {
        const response = json(429, { ok: false, error: { code }, retry_after_ms: retryAfterMs }, "1")

        expect(classifyDeliveryResponse(response)).toEqual({ kind: "wait", code, retryAfterMs })
    })

    it("waits on an edge 429 that carries no body, falling back to Retry-After when one is present", () => {
        expect(classifyDeliveryResponse(edge(429))).toEqual({ kind: "wait", code: "edge_rate_limited" })
        expect(classifyDeliveryResponse({ status: 429, json: undefined, retryAfter: "30" })).toEqual({
            kind: "wait",
            code: "edge_rate_limited",
            retryAfterMs: 30_000,
        })
    })

    it("refreshes a rejected token, and stops a profile on 404 or 405", () => {
        expect(classifyDeliveryResponse(failure(401, "token_expired"))).toEqual({ kind: "refresh_token" })
        expect(classifyDeliveryResponse(failure(404, "not_found"))).toEqual({ kind: "stop", scope: "profile", code: "not_found" })
        expect(classifyDeliveryResponse(edge(405))).toEqual({ kind: "stop", scope: "profile", code: "endpoint_unavailable" })
    })

    it("reports 413 apart from other refusals, so usage drops the batch and logs split it", () => {
        expect(classifyDeliveryResponse(failure(413, "payload_too_large"))).toEqual({ kind: "too_large" })
    })

    it.each([
        [422, "invalid_usage"],
        [409, "request_id_conflict"],
        [400, "request_id_required"],
    ])("discards a batch the service refuses for good with %i %s", (status, code) => {
        expect(classifyDeliveryResponse(failure(status, code))).toEqual({ kind: "discard", code })
    })

    it("replays the same bytes on 408 and 5xx, when the service may already hold the batch", () => {
        expect(classifyDeliveryResponse(failure(408, "timeout")).kind).toBe("replay")
        expect(classifyDeliveryResponse(failure(500, "internal_error")).kind).toBe("replay")
        expect(classifyDeliveryResponse(edge(502)).kind).toBe("replay")
        expect(classifyDeliveryResponse(failure(503, "unavailable", { retry_after_ms: 9_000 }))).toEqual({
            kind: "replay",
            retryAfterMs: 9_000,
        })
    })

    it("stops every remote profile for an edge block or an IP ban, and only one profile for a profile refusal", () => {
        expect(classifyDeliveryResponse(edge(403))).toEqual({ kind: "stop", scope: "all", code: "edge_blocked" })
        expect(classifyDeliveryResponse(failure(403, "ip_blocked"))).toEqual({ kind: "stop", scope: "all", code: "ip_blocked" })
        expect(classifyDeliveryResponse(failure(403, "usage_profile_required"))).toEqual({
            kind: "stop",
            scope: "profile",
            code: "usage_profile_required",
        })
    })
})

describe("wire validation", () => {
    it("reads Retry-After as seconds or as an HTTP date", () => {
        expect(parseRetryAfterMs("12", NOW)).toBe(12_000)
        expect(parseRetryAfterMs(new Date(NOW + 5_000).toUTCString(), NOW)).toBe(5_000)
        expect(parseRetryAfterMs("soon", NOW)).toBeUndefined()
    })
})
