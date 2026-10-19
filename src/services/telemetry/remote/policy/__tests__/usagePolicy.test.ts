import { describe, expect, it } from "vitest"
import {
    advanceUsagePolicy,
    describeUsagePolicyDecision,
    isServerStopExpired,
    parseServerStop,
    parseUsagePolicyDecision,
    resolveUsagePolicy,
    SERVER_STOP_RETRY_INTERVAL_MS,
    type UsagePolicyInputs,
} from "../usagePolicy"

const allowedInputs: UsagePolicyInputs = {
    usageConsent: "enabled",
    organizationDisabled: false,
    hostTelemetryLevel: "all",
    serverStop: undefined,
}

describe("remote usage policy", () => {
    it("sends usage under the usage profile once every input allows it", () => {
        expect(resolveUsagePolicy(allowedInputs)).toEqual({ allowed: true, profile: "usage" })
    })

    it.each([
        ["consent_off", { usageConsent: "unset" }],
        ["consent_off", { usageConsent: "disabled" }],
        ["organization_disabled", { organizationDisabled: true }],
        ["host_telemetry", { hostTelemetryLevel: "error" }],
        ["host_telemetry", { hostTelemetryLevel: "off" }],
        ["server_stopped", { serverStop: { scope: "all", code: "edge_blocked" } }],
    ] as const)("blocks with %s when %o", (reason, override) => {
        expect(resolveUsagePolicy({ ...allowedInputs, ...override })).toEqual({ allowed: false, reason })
    })

    it("names the decision and, when blocked, its reason for the log", () => {
        expect(describeUsagePolicyDecision(resolveUsagePolicy(allowedInputs))).toBe("allowed (profile usage)")
        expect(describeUsagePolicyDecision(resolveUsagePolicy({ ...allowedInputs, hostTelemetryLevel: "off" }))).toBe(
            "blocked (host_telemetry)",
        )
    })

    it("rejects decisions written by the removed consent-revision and development gates, so the record is rebuilt", () => {
        expect(parseUsagePolicyDecision({ allowed: false, reason: "development_unenrolled" })).toBeUndefined()
        expect(parseUsagePolicyDecision({ allowed: false, reason: "consent_revision" })).toBeUndefined()
        expect(parseUsagePolicyDecision({ allowed: true, profile: "development" })).toBeUndefined()
        expect(parseUsagePolicyDecision({ allowed: true, profile: "usage" })).toEqual({ allowed: true, profile: "usage" })
    })

    it("checks consent before anything a server or organization could change", () => {
        const everythingOff = { ...allowedInputs, usageConsent: "disabled", organizationDisabled: true } as const

        expect(resolveUsagePolicy(everythingOff)).toEqual({ allowed: false, reason: "consent_off" })
    })
})

describe("server stop retry", () => {
    const stoppedAt = 1_900_000_000_000
    const stop = { scope: "all", code: "edge_blocked", stoppedAt } as const

    it("holds a refusal for one retry interval and lets it lapse at the interval", () => {
        expect(isServerStopExpired(stop, stoppedAt + SERVER_STOP_RETRY_INTERVAL_MS - 1)).toBe(false)
        expect(isServerStopExpired(stop, stoppedAt + SERVER_STOP_RETRY_INTERVAL_MS)).toBe(true)
    })

    it("lets a refusal lapse when the clock moved back by more than one interval", () => {
        expect(isServerStopExpired(stop, stoppedAt - SERVER_STOP_RETRY_INTERVAL_MS)).toBe(true)
        expect(isServerStopExpired(stop, stoppedAt - 1)).toBe(false)
    })

    it("never lapses a refusal without a time on its own; the repository stamps it first", () => {
        expect(isServerStopExpired({ scope: "all", code: "edge_blocked" }, Number.MAX_SAFE_INTEGER)).toBe(false)
    })

    it("reads the recorded time and treats an unreadable time as absent instead of failing the stop", () => {
        expect(parseServerStop({ scope: "all", code: "edge_blocked", stopped_at: stoppedAt })).toEqual(stop)
        expect(parseServerStop({ scope: "profile", code: "forbidden", stopped_at: "soon" })).toEqual({
            scope: "profile",
            code: "forbidden",
        })
        expect(parseServerStop({ scope: "profile", code: "forbidden", stopped_at: 0 })).toEqual({
            scope: "profile",
            code: "forbidden",
        })
        expect(parseServerStop({ scope: "nowhere", code: "forbidden", stopped_at: stoppedAt })).toBeUndefined()
    })
})

describe("usage policy epoch", () => {
    it("starts at one and keeps its epoch while the decision stays the same", () => {
        const first = advanceUsagePolicy(undefined, { allowed: true, profile: "usage" })
        const again = advanceUsagePolicy(first, { allowed: true, profile: "usage" })

        expect(first.epoch).toBe(1)
        expect(again).toBe(first)
    })

    it("advances on every change, including a change between two blocking reasons", () => {
        const allowed = advanceUsagePolicy(undefined, { allowed: true, profile: "usage" })
        const off = advanceUsagePolicy(allowed, { allowed: false, reason: "consent_off" })
        const organization = advanceUsagePolicy(off, { allowed: false, reason: "organization_disabled" })

        expect([allowed.epoch, off.epoch, organization.epoch]).toEqual([1, 2, 3])
    })
})
