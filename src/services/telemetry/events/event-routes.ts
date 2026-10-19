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
    ["task.provider_api_error", "error"],
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
