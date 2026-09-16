import type { TelemetrySeverity } from "../providers/capabilities"
import type { TelemetryProperties } from "../providers/ITelemetryProvider"
import { TELEMETRY_MASK_VALUE } from "./content-policy"
import { exceptionAttributes } from "./exception-attributes"
import { RuntimeEventPriority, type RuntimeTelemetryEvent } from "./types"

export interface RuntimeEventTelemetrySink {
	captureRuntimeEvent(event: string, properties: TelemetryProperties, severity: TelemetrySeverity): void
}

/**
 * Projects a runtime-bus event onto the canonical telemetry provider registry.
 *
 * Error prose is represented by a stable mask. Type, code, source frame and
 * fingerprint preserve the failure identity needed for reconstruction without
 * persisting the original message.
 */
export function forwardRuntimeEvent(event: RuntimeTelemetryEvent, sink: RuntimeEventTelemetrySink): void {
	const properties: TelemetryProperties = {
		runtime_event_id: event.eventId,
		runtime_sequence: event.sequence,
		runtime_timestamp_ms: event.timestamp,
		runtime_monotonic_ms: event.monotonicMs,
		runtime_priority: event.priority,
		sessionId: event.context.sessionId,
		...event.attributes,
	}
	if (event.traceContext) {
		properties.runtime_trace_id = event.traceContext.traceId
		properties.runtime_span_id = event.traceContext.spanId
		properties.runtime_trace_flags = event.traceContext.traceFlags
	}
	if (event.context.taskId) properties.taskId = event.context.taskId
	if (event.context.controllerId) properties.controllerId = event.context.controllerId
	if (event.context.workspaceId) properties.workspaceId = event.context.workspaceId
	if (event.error) {
		Object.assign(properties, exceptionAttributes(event.error))
		properties.error_type = event.error.name
		properties.error_message = TELEMETRY_MASK_VALUE
		properties.error_fingerprint = event.error.fingerprint
		if (event.error.code) properties.error_code = event.error.code
		if (event.error.status !== undefined) properties.error_status = event.error.status
		if (event.error.sourceFrame) properties.error_source_frame = event.error.sourceFrame
	}
	const loggerWarning = event.attributes.logger_level === "warn" || event.attributes.message_level === "warning"
	sink.captureRuntimeEvent(event.name, properties, loggerWarning ? "warn" : severityFor(event.priority))
}

function severityFor(priority: RuntimeEventPriority): TelemetrySeverity {
	switch (priority) {
		case RuntimeEventPriority.Debug:
			return "debug"
		case RuntimeEventPriority.Info:
		case RuntimeEventPriority.PerformanceSample:
			return "info"
		case RuntimeEventPriority.PerformanceAnomaly:
			return "warn"
		case RuntimeEventPriority.Error:
			return "error"
		case RuntimeEventPriority.Invariant:
			return "fatal"
	}
}
