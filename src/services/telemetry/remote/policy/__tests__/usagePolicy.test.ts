import { describe, expect, it } from "vitest"
import { advanceUsagePolicy, REMOTE_USAGE_CONSENT_REVISION, resolveUsagePolicy, type UsagePolicyInputs } from "../usagePolicy"

const allowedInputs: UsagePolicyInputs = {
    usageConsent: "enabled",
    acknowledgedConsentRevision: REMOTE_USAGE_CONSENT_REVISION,
    organizationDisabled: false,
    hostTelemetryLevel: "all",
    isDevelopmentBuild: false,
    developmentEnrolled: false,
    serverStop: undefined,
}

describe("remote usage policy", () => {
    it("sends usage under the usage profile once every input allows it", () => {
        expect(resolveUsagePolicy(allowedInputs)).toEqual({ allowed: true, profile: "usage" })
    })

    it.each([
        ["consent_off", { usageConsent: "unset" }],
        ["consent_off", { usageConsent: "disabled" }],
        ["consent_revision", { acknowledgedConsentRevision: undefined }],
        ["consent_revision", { acknowledgedConsentRevision: REMOTE_USAGE_CONSENT_REVISION - 1 }],
        ["organization_disabled", { organizationDisabled: true }],
        ["host_telemetry", { hostTelemetryLevel: "error" }],
        ["host_telemetry", { hostTelemetryLevel: "off" }],
        ["server_stopped", { serverStop: { scope: "all", code: "edge_blocked" } }],
    ] as const)("blocks with %s when %o", (reason, override) => {
        expect(resolveUsagePolicy({ ...allowedInputs, ...override })).toEqual({ allowed: false, reason })
    })

    it("keeps an earlier opt-in local until the remote disclosure is confirmed", () => {
        const legacyOptIn = { ...allowedInputs, acknowledgedConsentRevision: undefined }

        expect(resolveUsagePolicy(legacyOptIn)).toEqual({ allowed: false, reason: "consent_revision" })
    })

    it("uses the development profile only with an enrollment and never falls back to production", () => {
        const development = { ...allowedInputs, isDevelopmentBuild: true }

        expect(resolveUsagePolicy({ ...development, developmentEnrolled: true })).toEqual({
            allowed: true,
            profile: "development",
        })
        expect(resolveUsagePolicy(development)).toEqual({ allowed: false, reason: "development_unenrolled" })
    })

    it("checks consent before anything a server or organization could change", () => {
        const everythingOff = { ...allowedInputs, usageConsent: "disabled", organizationDisabled: true } as const

        expect(resolveUsagePolicy(everythingOff)).toEqual({ allowed: false, reason: "consent_off" })
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
