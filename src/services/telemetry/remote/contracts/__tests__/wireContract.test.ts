import { describe, expect, it } from "vitest"
import { classifyUsageResponse, type WireResponse } from "../classification"
import { parseRetryAfterMs } from "../wire"

// Response bodies below follow the envelope of usage-contract §15.
const NOW = 1_800_000_000_000

const json = (status: number, body: unknown, retryAfter: string | null = null): WireResponse => ({
    status,
    json: body,
    retryAfter,
})
const edge = (status: number): WireResponse => ({ status, json: undefined, retryAfter: null })
const failure = (status: number, code: string, extra: Record<string, unknown> = {}) =>
    json(status, { ok: false, error: { code }, ...extra })
const classify = (response: WireResponse) => classifyUsageResponse(response, NOW)

describe("/usage response envelope (usage-contract §15)", () => {
    it.each([
        "accepted",
        "duplicate",
        "ignored_version",
    ] as const)("acknowledges a 200 ok:true %s and carries the gate the service named", (disposition) => {
        const response = json(200, {
            ok: true,
            request_id: "11111111-1111-4111-8111-111111111111",
            disposition,
            next_eligible_at: NOW + 600_000,
            dropped_fields: 2,
        })

        expect(classify(response)).toEqual({ kind: "acknowledged", disposition, nextEligibleAt: NOW + 600_000 })
    })

    it("replays the same bytes when a 200 does not confirm the request", () => {
        expect(classify(json(200, { ok: true })).kind).toBe("replay")
        expect(classify(json(200, { ok: true, disposition: "accepted" })).kind).toBe("replay")
        expect(classify(json(200, { ok: true, disposition: "stored", next_eligible_at: NOW })).kind).toBe("replay")
        expect(classify(json(200, { ok: false, disposition: "accepted", next_eligible_at: NOW })).kind).toBe("replay")
        // The flat body without the envelope confirms nothing either.
        expect(classify(json(200, { disposition: "accepted", next_eligible_at: NOW })).kind).toBe("replay")
        expect(classify(edge(200)).kind).toBe("replay")
    })

    it("waits for the gate a 429 names: next_eligible_at, then retry_after_ms, then Retry-After", () => {
        const gated = { ok: false, error: { code: "quota_limited" }, next_eligible_at: NOW + 7_000, retry_after_ms: 60_000 }
        expect(classify(json(429, gated, "60"))).toEqual({ kind: "wait", code: "quota_limited", retryAfterMs: 7_000 })
        expect(classify(json(429, { ok: false, error: { code: "telemetry_paused" }, retry_after_ms: 7_200_000 }, "60"))).toEqual({
            kind: "wait",
            code: "telemetry_paused",
            retryAfterMs: 7_200_000,
        })
        expect(classify(json(429, { ok: false, error: { code: "reservation_limited" } }, "60"))).toEqual({
            kind: "wait",
            code: "reservation_limited",
            retryAfterMs: 60_000,
        })
    })

    it("reads the delay only from the top level, where the envelope puts it", () => {
        expect(classify(json(429, { ok: false, error: { code: "telemetry_paused", retry_after_ms: 9_000 } }))).toEqual({
            kind: "wait",
            code: "telemetry_paused",
        })
    })

    it("waits on an edge 429 that carries no body, falling back to Retry-After when one is present", () => {
        expect(classify(edge(429))).toEqual({ kind: "wait", code: "edge_rate_limited" })
        expect(classify({ status: 429, json: undefined, retryAfter: "30" })).toEqual({
            kind: "wait",
            code: "edge_rate_limited",
            retryAfterMs: 30_000,
        })
    })

    it("refreshes a rejected token, and stops the profile on 404 or 405", () => {
        expect(classify(failure(401, "invalid_authorization"))).toEqual({ kind: "refresh_token" })
        expect(classify(failure(404, "not_found"))).toEqual({ kind: "stop", scope: "profile", code: "not_found" })
        expect(classify(edge(405))).toEqual({ kind: "stop", scope: "profile", code: "endpoint_unavailable" })
    })

    it("reports 413 apart from other refusals, since capacity guarding should have prevented it", () => {
        expect(classify(failure(413, "payload_too_large"))).toEqual({ kind: "too_large" })
    })

    it.each([
        [422, "invalid_usage_body"],
        [409, "request_id_conflict"],
        [400, "request_id_required"],
    ])("dead-letters a request the service refuses for good with %i %s", (status, code) => {
        expect(classify(failure(status, code))).toEqual({ kind: "discard", code })
    })

    it("replays the same bytes on 408 and 5xx, when the service may already hold the request", () => {
        expect(classify(failure(408, "timeout")).kind).toBe("replay")
        expect(classify(failure(500, "internal_error")).kind).toBe("replay")
        expect(classify(edge(502)).kind).toBe("replay")
        expect(classify(failure(503, "temporarily_unavailable", { retry_after_ms: 9_000 }))).toEqual({
            kind: "replay",
            retryAfterMs: 9_000,
        })
    })

    it("stops every remote profile for an edge block or an IP ban, and only one profile for a profile refusal", () => {
        expect(classify(edge(403))).toEqual({ kind: "stop", scope: "all", code: "edge_blocked" })
        expect(classify(failure(403, "ip_blocked"))).toEqual({ kind: "stop", scope: "all", code: "ip_blocked" })
        expect(classify(failure(403, "device_revoked"))).toEqual({ kind: "stop", scope: "profile", code: "device_revoked" })
    })
})

describe("wire validation", () => {
    it("reads Retry-After as seconds or as an HTTP date", () => {
        expect(parseRetryAfterMs("12", NOW)).toBe(12_000)
        expect(parseRetryAfterMs(new Date(NOW + 5_000).toUTCString(), NOW)).toBe(5_000)
        expect(parseRetryAfterMs("soon", NOW)).toBeUndefined()
    })
})
