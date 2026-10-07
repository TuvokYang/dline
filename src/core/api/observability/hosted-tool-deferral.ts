import { isTelemetryDevelopmentMode } from "@/services/telemetry/development-mode"
import { DiagnosticDomain, DiagnosticOutcome } from "@/services/telemetry/instrumentation/diagnostic-events"
import { recordDiagnostic } from "@/services/telemetry/instrumentation/diagnostic-recorder"
import { Logger } from "@/shared/services/Logger"

/** Wire protocol whose hosted calls can be deferred to a later request. */
type HostedDeferralApiFormat = "anthropic_messages"

/**
 * How a deferred hosted call ended.
 *
 * - `result_received` / `result_error`: the provider ran it at the start of the next request.
 * - `missing_result`: the next request ended without the result the history promised.
 * - `not_resumed`: the history no longer let the provider run it (compaction, rejection, tool undeclared).
 */
export type HostedDeferralResolution = "result_received" | "result_error" | "missing_result" | "not_resumed"

export interface HostedToolDeferredObservation {
	apiFormat: HostedDeferralApiFormat
	/** Provider-native hosted tool name, such as `web_search`. */
	hostedTool: string
	stopReason: string
	deferredCallCount: number
	clientToolCallCount: number
	pauseTurnContinuation: number
}

export interface HostedToolDeferralResolvedObservation {
	apiFormat: HostedDeferralApiFormat
	hostedTool: string
	resolution: HostedDeferralResolution
}

/**
 * Record that a provider postponed a hosted call behind client tool calls.
 *
 * Development builds only: the event exists to diagnose the deferral path, so production telemetry is unchanged.
 * The dimensions are counts and identifiers of the protocol only; query text, URLs, input, and results never
 * enter them.
 */
export function recordHostedToolDeferred(observation: HostedToolDeferredObservation): void {
	if (!isTelemetryDevelopmentMode()) return
	Logger.debug(
		`[HostedToolDeferral] ${observation.apiFormat} deferred ${observation.hostedTool} (stop_reason=${observation.stopReason}, client_tools=${observation.clientToolCallCount})`,
	)
	recordDiagnostic(DiagnosticDomain.Provider, "hosted_tool_deferred", DiagnosticOutcome.Observed, {
		api_format: observation.apiFormat,
		hosted_tool: observation.hostedTool,
		stop_reason: observation.stopReason,
		deferred_call_count: observation.deferredCallCount,
		client_tool_call_count: observation.clientToolCallCount,
		pause_turn_continuation: observation.pauseTurnContinuation,
	})
}

/** Record how a deferred hosted call ended; development builds only, with the same content-free dimensions. */
export function recordHostedToolDeferralResolved(observation: HostedToolDeferralResolvedObservation): void {
	if (!isTelemetryDevelopmentMode()) return
	Logger.debug(
		`[HostedToolDeferral] ${observation.apiFormat} ${observation.hostedTool} deferral resolved: ${observation.resolution}`,
	)
	recordDiagnostic(
		DiagnosticDomain.Provider,
		"hosted_tool_deferral_resolved",
		observation.resolution === "result_received" ? DiagnosticOutcome.Recovered : DiagnosticOutcome.Failed,
		{
			api_format: observation.apiFormat,
			hosted_tool: observation.hostedTool,
			resolution: observation.resolution,
		},
	)
}
