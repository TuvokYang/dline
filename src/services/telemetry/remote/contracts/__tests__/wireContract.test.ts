import { describe, expect, it } from "vitest"
import { classifyDeliveryResponse, classifyExchangeResponse, type WireResponse } from "../classification"
import { buildDeviceExchangeRequest, parseRetryAfterMs } from "../wire"

// Response bodies below follow the service's documented wire format.
const SECRET = "A".repeat(43)
const TOKEN = "t".repeat(43)
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
        "ignored_version",
    ] as const)("acknowledges a 200 ok:true %s and carries the gate the service named", (disposition) => {
        const response = json(200, { ok: true, disposition, next_eligible_at: NOW + 600_000, dropped_fields: 2 })

        expect(classifyDeliveryResponse(response)).toEqual({ kind: "acknowledged", disposition, nextEligibleAt: NOW + 600_000 })
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

describe("device exchange classification", () => {
    const grant = {
        ok: true,
        access_token: TOKEN,
        device_id: `dev_${"a".repeat(32)}`,
        endpoint: "https://otel.dline.cc",
        profile: "usage",
        scopes: ["usage"],
        expires_at: NOW + 30 * 86_400_000,
        capture_policy: { metric_export_interval_ms: 60_000 },
        rate_limits: { request_capacity: 2 },
        request_id: "r",
    }

    it("reads the grant the client acts on and ignores the rest", () => {
        expect(classifyExchangeResponse(json(200, grant))).toEqual({
            kind: "granted",
            grant: {
                accessToken: TOKEN,
                deviceId: grant.device_id,
                profile: "usage",
                expiresAt: grant.expires_at,
                metricExportIntervalMs: 60_000,
            },
        })
    })

    it("backs off instead of trusting a grant with a malformed token", () => {
        expect(classifyExchangeResponse(json(200, { ...grant, access_token: "short" })).kind).toBe("backoff")
    })

    it("backs off for the enrollment budget using the server's Retry-After", () => {
        const limited = json(429, { ok: false, retryable: true, error: { code: "device_enrollment_rate_limited" } }, "60")

        expect(classifyExchangeResponse(limited)).toEqual({
            kind: "backoff",
            code: "device_enrollment_rate_limited",
            retryAfterMs: 60_000,
        })
    })

    it("resets the device credential when the server revoked it, even without an error message", () => {
        const revoked = json(403, { ok: false, error: { code: "device_revoked" } })

        expect(classifyExchangeResponse(revoked)).toEqual({ kind: "reset_credential", code: "device_revoked" })
    })

    it("stops on a credential conflict and stops everything on an edge block", () => {
        expect(classifyExchangeResponse(json(409, { ok: false, error: { code: "device_credential_conflict" } }))).toEqual({
            kind: "stop",
            scope: "profile",
            code: "device_credential_conflict",
        })
        expect(classifyExchangeResponse(edge(403))).toEqual({ kind: "stop", scope: "all", code: "edge_blocked" })
    })
})

describe("wire builders and validation", () => {
    it("refuses a device secret the server would reject", () => {
        expect(() =>
            buildDeviceExchangeRequest({ deviceSecret: "short", profile: "usage", clientVersion: "1.0.0", platform: "win32" }),
        ).toThrow()
    })

    it("keeps client fields within the server's 1-64 character bounds", () => {
        const request = buildDeviceExchangeRequest({
            deviceSecret: SECRET,
            profile: "usage",
            clientVersion: "9".repeat(80),
            platform: "",
        })

        expect(request.client_version).toHaveLength(64)
        expect(request.platform.length).toBeGreaterThan(0)
    })

    it("reads Retry-After as seconds or as an HTTP date", () => {
        expect(parseRetryAfterMs("12", NOW)).toBe(12_000)
        expect(parseRetryAfterMs(new Date(NOW + 5_000).toUTCString(), NOW)).toBe(5_000)
        expect(parseRetryAfterMs("soon", NOW)).toBeUndefined()
    })
})
