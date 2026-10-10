/**
 * Vocabulary shared by the incident correlator and the root-cause analyzer.
 *
 * The categories are deliberately narrow. "Something was slow" is not a
 * diagnosis; "the upstream provider was slow while our own loop was idle" is.
 * Each category therefore names both the responsible component and the failure
 * mode, so the reader knows where to look next.
 */

import type { RuntimeTelemetryEvent } from "../types"

/** The component a diagnosis points at. */
export enum RootCauseCategory {
    /** Upstream model API took too long to respond. */
    ProviderUpstreamLatency = "provider.upstream_latency",
    /** Credentials were rejected. */
    ProviderAuthentication = "provider.authentication",
    /** Upstream throttled us. */
    ProviderRateLimit = "provider.rate_limit",
    /** The stream started but could not be parsed or completed. */
    ProviderStreamProtocol = "provider.stream_protocol",
    /** Our own event loop was blocked, so even local work was slow. */
    RuntimeEventLoopBlocked = "runtime.event_loop_blocked",
    /** Building or serializing the webview state projection dominated. */
    StateProjectionSerialization = "state.projection_serialization",
    /** The extension host delivered state promptly but the webview was slow. */
    WebviewRenderLatency = "webview.render_latency",
    /** Disk writes queued or stalled. */
    PersistenceDiskBackpressure = "persistence.disk_backpressure",
    /** An MCP server connection or reconnect cycle failed. */
    McpTransportLifecycle = "mcp.transport_lifecycle",
    /** The MCP connection was healthy but the tool itself was slow. */
    McpToolLatency = "mcp.tool_latency",
    /** The command finished but capturing or finalizing its output was slow. */
    TerminalOutputFinalization = "terminal.output_finalization",
    /** A task state transition was rejected or an effect failed. */
    TaskRuntimeInvariant = "task.runtime_invariant",
    /** Telemetry itself is degraded; business components are fine. */
    TelemetryTransportUnhealthy = "telemetry.transport_unhealthy",
    /** Evidence was insufficient to choose a category. */
    Unknown = "unknown",
}

/**
 * Evidence the analyzer could not find.
 *
 * Reported alongside `Unknown` so the reader learns what instrumentation is
 * missing rather than being told "no idea".
 */
export enum MissingEvidence {
    /** No runtime health snapshot covered the incident window. */
    RuntimeSnapshot = "runtime_snapshot",
    /** The failing operation reported no phase timings. */
    PhaseTimings = "phase_timings",
    /** No error was normalized for the failing event. */
    NormalizedError = "normalized_error",
    /** No successful event preceded the failure, so nothing establishes a baseline. */
    PriorSuccess = "prior_success",
}

/**
 * How strongly the evidence supports the category.
 *
 * Confidence is deliberately coarse. A continuous score invites tuning until
 * the number looks good; three levels force the rules to state what they
 * actually proved.
 */
export enum DiagnosisConfidence {
    /** A defining signal was present and competing explanations were excluded. */
    High = "high",
    /** The defining signal was present but a competing explanation was not excluded. */
    Medium = "medium",
    /** Only circumstantial evidence was available. */
    Low = "low",
}

/** A window of correlated events around one failure. */
export interface Incident {
    readonly incidentId: string
    /** The event that made the failure observable. */
    readonly failingEvent: RuntimeTelemetryEvent
    /** Events recorded before the failure, oldest first. */
    readonly precedingEvents: readonly RuntimeTelemetryEvent[]
    /** The most recent successful completion of the same operation, if any. */
    readonly lastSuccess?: RuntimeTelemetryEvent
}

export interface RootCauseDiagnosis {
    readonly incidentId: string
    readonly category: RootCauseCategory
    readonly confidence: DiagnosisConfidence
    /** Component the diagnosis blames, for example `provider` or `mcp`. */
    readonly component: string
    /** Operation within that component, for example `stream`. */
    readonly operation: string
    /** Event ids that justify the category. At least two whenever a rule fires. */
    readonly evidenceEventIds: readonly string[]
    readonly failingEventId: string
    readonly lastSuccessEventId?: string
    /** Ordered, content-free steps a maintainer can follow to reproduce. */
    readonly reproductionSteps: readonly string[]
    /** Populated when evidence was insufficient. */
    readonly missingEvidence?: readonly MissingEvidence[]
}
