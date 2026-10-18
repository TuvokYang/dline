import { isReportingAllowed, type TelemetrySetting } from "@shared/TelemetrySetting"
import type { StopScope } from "../contracts/classification"

/** VS Code's `telemetry.telemetryLevel`; usage data is only allowed at `all`. */
export type HostTelemetryLevel = "all" | "error" | "crash" | "off"

/** A refusal the service returned, kept until the user or an explicit reset clears it. */
export interface ServerStop {
    readonly scope: StopScope
    readonly code: string
}

export interface UsagePolicyInputs {
    /** The user's usage reporting setting; it defaults to on and only the user turns it off. */
    readonly usageConsent: TelemetrySetting
    /** Organization Remote Config turned telemetry off; it can only disable, never enable. */
    readonly organizationDisabled: boolean
    readonly hostTelemetryLevel: HostTelemetryLevel
    readonly serverStop: ServerStop | undefined
}

export const USAGE_POLICY_BLOCKS = ["consent_off", "organization_disabled", "host_telemetry", "server_stopped"] as const
export type UsagePolicyBlock = (typeof USAGE_POLICY_BLOCKS)[number]

/**
 * Development builds send under the same profile; their batches carry the
 * `is_dev` attribute, so the service separates them without a second stream.
 */
export type UsagePolicyDecision =
    | { readonly allowed: true; readonly profile: "usage" }
    | { readonly allowed: false; readonly reason: UsagePolicyBlock }

/**
 * Decide whether remote usage may be collected and sent. Every input can only
 * narrow: no server field or organization setting grants what the user turned off.
 */
export function resolveUsagePolicy(inputs: UsagePolicyInputs): UsagePolicyDecision {
    if (!isReportingAllowed(inputs.usageConsent)) return { allowed: false, reason: "consent_off" }
    if (inputs.organizationDisabled) return { allowed: false, reason: "organization_disabled" }
    if (inputs.hostTelemetryLevel !== "all") return { allowed: false, reason: "host_telemetry" }
    if (inputs.serverStop) return { allowed: false, reason: "server_stopped" }
    return { allowed: true, profile: "usage" }
}

/** One line for the log: what the decision is and, when blocked, why. */
export function describeUsagePolicyDecision(decision: UsagePolicyDecision): string {
    return decision.allowed ? `allowed (profile ${decision.profile})` : `blocked (${decision.reason})`
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
        return value.profile === "usage" ? { allowed: true, profile: "usage" } : undefined
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
