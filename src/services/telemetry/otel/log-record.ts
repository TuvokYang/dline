import { ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { type LogRecord, SeverityNumber } from "@opentelemetry/api-logs"
import type { TelemetryProperties } from "../providers/ITelemetryProvider"

/** Map canonical event semantics before attribute masking/cardinality processing. */
export function logRecordFields(
	properties?: TelemetryProperties,
): Pick<LogRecord, "severityNumber" | "severityText" | "timestamp" | "context"> {
	const severity = properties?.telemetry_severity
	const severityNumber =
		severity === "debug"
			? SeverityNumber.DEBUG
			: severity === "warn"
				? SeverityNumber.WARN
				: severity === "error"
					? SeverityNumber.ERROR
					: severity === "fatal"
						? SeverityNumber.FATAL
						: SeverityNumber.INFO
	const traceId = properties?.runtime_trace_id
	const spanId = properties?.runtime_span_id
	const validContext =
		typeof traceId === "string" &&
		/^[\da-f]{32}$/.test(traceId) &&
		!/^0+$/.test(traceId) &&
		typeof spanId === "string" &&
		/^[\da-f]{16}$/.test(spanId) &&
		!/^0+$/.test(spanId)
	return {
		severityNumber,
		severityText: SeverityNumber[severityNumber],
		timestamp: epochMillisecondsToHrTime(eventTimestamp(properties)),
		// Never inherit the drain timer's ambient context for an uncorrelated event.
		context: validContext
			? trace.setSpanContext(ROOT_CONTEXT, { traceId, spanId, traceFlags: properties?.runtime_trace_flags === 1 ? 1 : 0 })
			: ROOT_CONTEXT,
	}
}

export function epochMillisecondsToHrTime(value: number): [number, number] {
	return [Math.floor(value / 1_000), Math.round((value % 1_000) * 1_000_000)]
}

export function eventTimestamp(properties?: TelemetryProperties): number {
	const value = properties?.runtime_timestamp_ms ?? properties?.telemetry_timestamp_ms
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : Date.now()
}
