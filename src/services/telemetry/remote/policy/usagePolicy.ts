import { isReportingAllowed, type TelemetrySetting } from "@shared/TelemetrySetting"
import type { StopScope } from "../contracts/classification"

/** VS Code's `telemetry.telemetryLevel`; usage data is only allowed at `all`. */
export type HostTelemetryLevel = "all" | "error" | "crash" | "off"

/**
 * A refusal the service returned. It holds for {@link SERVER_STOP_RETRY_INTERVAL_MS}
 * and lapses earlier when a window starts, so a block that was lifted, or an edge
 * rule that was fixed, does not keep a device silent until someone edits its files.
 */
export interface ServerStop {
    readonly scope: StopScope
    readonly code: string
    /** When the refusal was recorded; absent only on stops written by builds that held them forever. */
    readonly stoppedAt?: number
}

/** A refusal in the form the service returns it, before the repository records when it happened. */
export type ServerRefusal = Pick<ServerStop, "scope" | "code">

/**
 * How long a refusal keeps delivery off before the next cycle tries again. A service
 * that still refuses answers the retry with a new refusal, so the device asks at most
 * once per interval instead of on every cycle.
 */
export const SERVER_STOP_RETRY_INTERVAL_MS = 30 * 60_000

/**
 * Whether a recorded refusal has lapsed. A clock that moved by more than one interval
 * in either direction also lapses it, so a refusal stamped in the future cannot hold forever.
 */
export function isServerStopExpired(stop: ServerStop, now: number): boolean {
    if (stop.stoppedAt === undefined) return false
    return Math.abs(now - stop.stoppedAt) >= SERVER_STOP_RETRY_INTERVAL_MS
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
 * Development builds send under the same profile; their batches carry
 * `client.is_dev` instead of using a second stream.
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

/** One line for the log: distinguish policy permission from an actual delivery outcome. */
export function describeUsagePolicyDecision(decision: UsagePolicyDecision): string {
    return decision.allowed
        ? "policy permits local collection and remote delivery attempts"
        : `reporting blocked (${decision.reason})`
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

/**
 * Strict on scope and code, lenient on the time: an unreadable `stopped_at` reads as
 * absent, which the repository stamps with the current time, so the refusal still holds
 * for a full interval instead of failing the whole document.
 */
export function parseServerStop(value: unknown): ServerStop | undefined {
    if (!isRecord(value)) return undefined
    const { scope, code, stopped_at: stoppedAt } = value
    if ((scope !== "profile" && scope !== "all") || typeof code !== "string" || code.length === 0 || code.length > 128) {
        return undefined
    }
    return Number.isSafeInteger(stoppedAt) && (stoppedAt as number) > 0
        ? { scope, code, stoppedAt: stoppedAt as number }
        : { scope, code }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sameDecision(left: UsagePolicyDecision, right: UsagePolicyDecision): boolean {
    if (left.allowed !== right.allowed) return false
    return left.allowed ? left.profile === (right as typeof left).profile : left.reason === (right as typeof left).reason
}
