import type { DeliveryDisposition } from "../contracts/wire"
import type { UsageCycleResult } from "./UsageDeliveryWorker"

export type RemoteUsageLogLevel = "debug" | "info" | "warn"

/** Local, content-free diagnostics; never routed back through remote telemetry. */
export type RemoteUsageLog = (level: RemoteUsageLogLevel, message: string) => void

export interface UsageCycleLogLine {
    readonly level: RemoteUsageLogLevel
    readonly message: string
    /**
     * Set for a state that recurs on every cycle while nothing changes, such as
     * "nothing due". The coordinator prints it once when the state is entered
     * instead of every 30 seconds. Unset for a result that is an event of its own.
     */
    readonly steadyState?: string
}

/** One log line for the outcome of a delivery cycle; batches are named by a short prefix of their request ID. */
export function describeUsageCycle(result: UsageCycleResult): UsageCycleLogLine {
    switch (result.kind) {
        case "standby":
            return {
                level: "debug",
                message: "standing by: waiting for this window's turn with the sender lease",
                steadyState: "standby",
            }
        case "fenced":
            return {
                level: "debug",
                message: "the sender lease lapsed during the cycle; the next holder resumes the batch",
                steadyState: "fenced",
            }
        case "idle":
            return { level: "debug", message: "nothing due to send", steadyState: "idle" }
        case "aborted":
            return { level: "debug", message: "delivery cycle aborted" }
        case "waiting": {
            const retry = result.retryAt === undefined ? "" : `, next attempt after ${new Date(result.retryAt).toISOString()}`
            return {
                level: "debug",
                message: `waiting for a device token (${result.reason}${retry})`,
                steadyState: `waiting:${result.reason}`,
            }
        }
        case "delivered":
            return { level: "debug", message: `batch ${batchName(result.requestId)} ${DISPOSITION_TEXT[result.disposition]}` }
        case "retrying":
            return {
                level: "warn",
                message: `batch ${batchName(result.requestId)} was not acknowledged; the same bytes are sent again later`,
            }
        case "paused":
            return {
                level: "info",
                message: `the service asked to wait (${result.code}); usage is held until ${new Date(result.until).toISOString()} and batch ${batchName(result.requestId)} is rebuilt then`,
            }
        case "discarded":
            return { level: "warn", message: `batch ${batchName(result.requestId)} discarded (${result.code})` }
        case "rejected":
            return { level: "warn", message: `batch rejected locally (${result.violations.join(", ")})` }
        case "stopped":
            return { level: "warn", message: `usage reporting stopped by the service (${result.scope}: ${result.code})` }
    }
}

const DISPOSITION_TEXT: Record<DeliveryDisposition, string> = {
    accepted: "delivered",
    duplicate: "had already been accepted (duplicate)",
    ignored_version: "acknowledged; the service ignores this Dline version",
}

function batchName(requestId: string): string {
    return requestId.slice(0, 8)
}
