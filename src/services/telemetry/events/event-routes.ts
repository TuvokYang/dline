import type { TelemetryChannel, TelemetrySeverity } from "../providers/capabilities"

/** The consent channel and severity a catalog event travels with. */
export interface TelemetryEventRoute {
    readonly channel: TelemetryChannel
    readonly severity: TelemetrySeverity
}

const USAGE_ROUTE: TelemetryEventRoute = { channel: "usage", severity: "info" }

/**
 * Catalog events that report a failure.
 *
 * They travel on the error channel, so error-reporting consent governs them and
 * error sinks receive them; every other catalog event stays on the usage
 * channel. The list is explicit on purpose: a route is never guessed from an
 * event name, so a new event lands on the error channel only by being added here.
 */
const ERROR_EVENT_SEVERITIES: ReadonlyMap<string, TelemetrySeverity> = new Map([
    ["user.extension_storage_error", "error"],
    ["user.auth_failed", "warn"],
    ["workspace.init_error", "error"],
    ["task.browser_error", "error"],
    ["task.diff_edit_failed", "warn"],
    ["task.terminal_output_failure", "warn"],
    ["task.terminal_hang", "warn"],
    ["task.mention_failed", "warn"],
])

/** Route of one catalog event: the error channel for a listed failure, usage otherwise. */
export function routeOfEvent(event: string): TelemetryEventRoute {
    const severity = ERROR_EVENT_SEVERITIES.get(event)
    return severity ? { channel: "error", severity } : USAGE_ROUTE
}

/**
 * Runtime-bus events that may leave the device, with the channel each travels on.
 *
 * Failures travel on the error channel; process health facts on the runtime
 * channel. Every other runtime event stays on the runtime channel and in local
 * sinks only: projections that repeat a failure already listed here
 * (`task.error`), warnings, cancellations and lifecycle facts.
 */
const REMOTE_RUNTIME_EVENT_CHANNELS: ReadonlyMap<string, "error" | "runtime"> = new Map([
    ["api.request.failed", "error"],
    ["tool.execution.failed", "error"],
    ["subagent.run.failed", "error"],
    ["mcp.tools.call.failed", "error"],
    ["extension.error", "error"],
    ["runtime.cpu_utilization_ratio.breach", "runtime"],
    ["runtime.event_loop_delay_ms.breach", "runtime"],
    ["runtime.heap_growth_bytes.breach", "runtime"],
    ["runtime.previous_session_reconciled", "runtime"],
    ["task.tool.interrupted_inferred", "runtime"],
])

/** Channel of one runtime-bus event: the error channel for a listed failure, runtime otherwise. */
export function channelOfRuntimeEvent(event: string): TelemetryChannel {
    return REMOTE_RUNTIME_EVENT_CHANNELS.get(event) ?? "runtime"
}

/**
 * Whether an event may leave the device as a remote diagnostic.
 *
 * Fails closed: an event listed in neither table stays in local sinks whatever
 * its channel and severity, so a new event is reported remotely only by being
 * added here.
 */
export function isRemoteDiagnosticEvent(event: string): boolean {
    return ERROR_EVENT_SEVERITIES.has(event) || REMOTE_RUNTIME_EVENT_CHANNELS.has(event)
}
