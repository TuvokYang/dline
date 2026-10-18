import { describe, expect, it } from "vitest"
import { classifyExchangeResponse, classifyUsageResponse, type WireResponse } from "../classification"
import { buildDeviceExchangeRequest, parseRetryAfterMs, type UsageAggregateWire, validateUsageAggregate } from "../wire"

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

describe("usage response classification", () => {
    it("acknowledges an accepted batch and a duplicate of one", () => {
        const accepted = json(200, { ok: true, disposition: "accepted", duplicate: false, next_eligible_at: NOW })
        const duplicate = json(200, { ok: true, disposition: "duplicate", duplicate: true, next_eligible_at: NOW })

        expect(classifyUsageResponse(accepted)).toEqual({ kind: "acknowledged", duplicate: false })
        expect(classifyUsageResponse(duplicate)).toEqual({ kind: "acknowledged", duplicate: true })
    })

    it("replays the same bytes when a 200 does not confirm the batch", () => {
        expect(classifyUsageResponse(json(200, { ok: true })).kind).toBe("replay")
    })

    it("defers to a later window when the 60-second gate or the quota refuses the batch", () => {
        const gate = failure(429, "usage_interval_not_elapsed", { retry_after_ms: 12_000, next_eligible_at: NOW + 12_000 })
        const quota = json(429, { ok: false, retryable: true, error: { code: "rate_limited" } }, "30")

        expect(classifyUsageResponse({ ...gate, retryAfter: "12" })).toEqual({
            kind: "defer",
            code: "usage_interval_not_elapsed",
            retryAfterMs: 12_000,
        })
        expect(classifyUsageResponse(quota)).toEqual({ kind: "defer", code: "rate_limited", retryAfterMs: 30_000 })
    })

    it("refreshes the token once the server rejects it", () => {
        expect(classifyUsageResponse(failure(401, "token_expired"))).toEqual({ kind: "refresh_token" })
        expect(classifyUsageResponse(failure(401, "invalid_access_token"))).toEqual({ kind: "refresh_token" })
    })

    it.each([
        [409, "request_id_conflict"],
        [413, "payload_too_large"],
        [415, "unsupported_content_type"],
        [422, "invalid_usage_aggregate"],
        [400, "request_id_required"],
    ])("discards a batch the server permanently refuses with %i %s", (status, code) => {
        expect(classifyUsageResponse(failure(status, code))).toEqual({ kind: "discard", code })
    })

    it("replays the same bytes when the server may already have stored the batch", () => {
        expect(classifyUsageResponse(failure(500, "internal_error")).kind).toBe("replay")
        expect(classifyUsageResponse(failure(503, "usage_gate_unavailable")).kind).toBe("replay")
        expect(classifyUsageResponse(edge(502)).kind).toBe("replay")
        expect(classifyUsageResponse(edge(504)).kind).toBe("replay")
    })

    it("stops every remote profile for an edge block or an IP ban, and only usage for a profile refusal", () => {
        expect(classifyUsageResponse(edge(403))).toEqual({ kind: "stop", scope: "all", code: "edge_blocked" })
        expect(classifyUsageResponse(failure(403, "ip_blocked"))).toEqual({ kind: "stop", scope: "all", code: "ip_blocked" })
        expect(classifyUsageResponse(failure(403, "usage_profile_required"))).toEqual({
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

    const valid: UsageAggregateWire = {
        schema_version: 1,
        window_started_at: NOW - 120_000,
        window_ended_at: NOW - 60_000,
        aggregation_count: 1,
        counters: { "dline.usage.requests.task.completed": 3 },
        measurements: { "dline.usage.request_duration_ms.task": { count: 3, sum: 300, min: 50, max: 150 } },
        attributes: { client_version: "0.11.0", platform: "win32", is_dev: false },
    }

    it("accepts an aggregate the server schema accepts", () => {
        expect(validateUsageAggregate(valid, NOW)).toEqual([])
    })

    it("names every rule an aggregate breaks before it can become an inflight batch", () => {
        const broken: UsageAggregateWire = {
            ...valid,
            window_started_at: NOW - 10 * 60_000,
            counters: { "Dline.Usage": 1, "dline.ok": -1 },
            measurements: { "dline.duration": { count: 2, sum: 500, min: 10, max: 100 } },
            attributes: { platform: "win32", account: "someone" } as UsageAggregateWire["attributes"],
        }

        expect(validateUsageAggregate(broken, NOW)).toEqual(
            expect.arrayContaining(["window_span", "metric_name", "counter_value", "measurement_bounds", "attribute_key"]),
        )
    })
})
