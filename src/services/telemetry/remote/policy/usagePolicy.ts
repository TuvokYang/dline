import { isReportingAllowed, type TelemetrySetting } from "@shared/TelemetrySetting"
import type { StopScope } from "../contracts/classification"

/**
 * Revision of the remote usage disclosure. A user who opted in to usage
 * reporting before remote delivery existed agreed to local collection only,
 * so remote delivery waits until they confirm this revision.
 */
export const REMOTE_USAGE_CONSENT_REVISION = 1

/** VS Code's `telemetry.telemetryLevel`; usage data is only allowed at `all`. */
export type HostTelemetryLevel = "all" | "error" | "crash" | "off"

/** A refusal the service returned, kept until the user or an explicit reset clears it. */
export interface ServerStop {
    readonly scope: StopScope
    readonly code: string
}

export interface UsagePolicyInputs {
    readonly usageConsent: TelemetrySetting
    readonly acknowledgedConsentRevision: number | undefined
    /** Organization Remote Config turned telemetry off; it can only disable, never enable. */
    readonly organizationDisabled: boolean
    readonly hostTelemetryLevel: HostTelemetryLevel
    readonly isDevelopmentBuild: boolean
    /** A development build sends only with a valid enrollment; it never falls back to the production profile. */
    readonly developmentEnrolled: boolean
    readonly serverStop: ServerStop | undefined
}

export const USAGE_POLICY_BLOCKS = [
    "consent_off",
    "consent_revision",
    "organization_disabled",
    "host_telemetry",
    "development_unenrolled",
    "server_stopped",
] as const
export type UsagePolicyBlock = (typeof USAGE_POLICY_BLOCKS)[number]

export type UsagePolicyDecision =
    | { readonly allowed: true; readonly profile: "usage" | "development" }
    | { readonly allowed: false; readonly reason: UsagePolicyBlock }

/**
 * Decide whether remote usage may be collected and sent. Every input can only
 * narrow: no server field, organization setting or build flag grants what the
 * user's consent did not.
 */
export function resolveUsagePolicy(inputs: UsagePolicyInputs): UsagePolicyDecision {
    if (!isReportingAllowed(inputs.usageConsent)) return { allowed: false, reason: "consent_off" }
    if ((inputs.acknowledgedConsentRevision ?? 0) < REMOTE_USAGE_CONSENT_REVISION) {
        return { allowed: false, reason: "consent_revision" }
    }
    if (inputs.organizationDisabled) return { allowed: false, reason: "organization_disabled" }
    if (inputs.hostTelemetryLevel !== "all") return { allowed: false, reason: "host_telemetry" }
    if (inputs.serverStop) return { allowed: false, reason: "server_stopped" }
    if (inputs.isDevelopmentBuild) {
        return inputs.developmentEnrolled
            ? { allowed: true, profile: "development" }
            : { allowed: false, reason: "development_unenrolled" }
    }
    return { allowed: true, profile: "usage" }
}

/** The machine-wide policy record every instance reads before it claims, sends or acknowledges a batch. */
export interface UsagePolicyRecord {
    /** Increases on every change, so work started under an older decision can recognise itself as stale. */
    readonly epoch: number
    readonly decision: UsagePolicyDecision
}

/** Advance the record when the decision changed; an unchanged decision keeps its epoch. */
export function advanceUsagePolicy(previous: UsagePolicyRecord | undefined, decision: UsagePolicyDecision): UsagePolicyRecord {
    if (previous && sameDecision(previous.decision, decision)) return previous
    return { epoch: (previous?.epoch ?? 0) + 1, decision }
}

/** Turn an allowed decision off because the service refused it; a decision that is already off keeps its reason. */
export function stopUsagePolicy(previous: UsagePolicyRecord): UsagePolicyRecord {
    return previous.decision.allowed ? advanceUsagePolicy(previous, { allowed: false, reason: "server_stopped" }) : previous
}

/** Strict reader for a persisted decision; anything unrecognised is rejected so the caller fails closed. */
export function parseUsagePolicyDecision(value: unknown): UsagePolicyDecision | undefined {
    if (!isRecord(value)) return undefined
    if (value.allowed === true) {
        return value.profile === "usage" || value.profile === "development"
            ? { allowed: true, profile: value.profile }
            : undefined
    }
    if (value.allowed === false && USAGE_POLICY_BLOCKS.includes(value.reason as UsagePolicyBlock)) {
        return { allowed: false, reason: value.reason as UsagePolicyBlock }
    }
    return undefined
}

export function parseServerStop(value: unknown): ServerStop | undefined {
    if (!isRecord(value)) return undefined
    const { scope, code } = value
    if ((scope !== "profile" && scope !== "all") || typeof code !== "string" || code.length === 0 || code.length > 128) {
        return undefined
    }
    return { scope, code }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameDecision(left: UsagePolicyDecision, right: UsagePolicyDecision): boolean {
    if (left.allowed !== right.allowed) return false
    return left.allowed ? left.profile === (right as typeof left).profile : left.reason === (right as typeof left).reason
}
