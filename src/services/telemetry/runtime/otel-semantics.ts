import type { AnyValue, LogAttributes } from "@opentelemetry/api-logs"
import { SeverityNumber } from "@opentelemetry/api-logs"
import { RuntimeContentPolicy, TELEMETRY_MASK_VALUE } from "./content-policy"
import { exceptionAttributes } from "./exception-attributes"

export { EXCEPTION_ATTRIBUTE_KEYS } from "./exception-attributes"

import { RuntimeEventPriority, type RuntimeTelemetryEvent } from "./types"

/**
 * Maps runtime telemetry onto the OpenTelemetry logs data model.
 *
 * The pipeline used to define its own wire format, which meant nothing outside
 * this repository could read it: a field named `priority` carrying 0-4 is not a
 * severity any collector recognises, and a body of `{ events: [...] }` is not
 * OTLP. Every consumer therefore needed a bespoke adapter.
 *
 * Keeping the mapping in one module means the transport, the journal and the
 * diagnostic export all describe an event the same way. It is a pure
 * translation with no I/O so it can be asserted against the specification
 * directly.
 */

/** Instrumentation scope for runtime diagnostics, distinct from product analytics. */
export { RUNTIME_SCOPE_NAME, RUNTIME_SCOPE_VERSION } from "@/services/telemetry/otel/scopes"

/**
 * Prefix for fields that have no semantic-convention equivalent.
 *
 * Ordering data such as the bus sequence is specific to this pipeline.
 * Publishing it unprefixed would risk colliding with a future convention and
 * would hide which attributes are ours.
 */
const DLINE_PREFIX = "dline."

export const RUNTIME_ATTRIBUTE_KEYS = {
	sequence: `${DLINE_PREFIX}sequence`,
	eventId: `${DLINE_PREFIX}event_id`,
	monotonicMs: `${DLINE_PREFIX}monotonic_ms`,
	taskId: `${DLINE_PREFIX}task_id`,
	controllerId: `${DLINE_PREFIX}controller_id`,
	workspaceId: `${DLINE_PREFIX}workspace_id`,
} as const

/**
 * Translates internal priority to the standard severity scale.
 *
 * The two scales are not interchangeable: `RuntimeEventPriority` orders events
 * by how much their loss would cost an investigation, while `SeverityNumber`
 * describes how severe the reported condition is. A performance breach is
 * mapped to WARN rather than INFO because it reports degraded behaviour, and an
 * invariant breach to FATAL because it reports a defect in our own assumptions.
 */
export function toSeverityNumber(priority: RuntimeEventPriority): SeverityNumber {
	switch (priority) {
		case RuntimeEventPriority.Debug:
			return SeverityNumber.DEBUG
		case RuntimeEventPriority.Info:
			return SeverityNumber.INFO
		case RuntimeEventPriority.Performance:
			return SeverityNumber.INFO
		case RuntimeEventPriority.PerformanceAnomaly:
			return SeverityNumber.WARN
		case RuntimeEventPriority.Error:
			return SeverityNumber.ERROR
		case RuntimeEventPriority.Invariant:
			return SeverityNumber.FATAL
	}
}

/** Human-readable counterpart of {@link toSeverityNumber}. */
export function toSeverityText(priority: RuntimeEventPriority): string {
	switch (priority) {
		case RuntimeEventPriority.Debug:
			return "DEBUG"
		case RuntimeEventPriority.Info:
			return "INFO"
		case RuntimeEventPriority.Performance:
			return "INFO"
		case RuntimeEventPriority.PerformanceAnomaly:
			return "WARN"
		case RuntimeEventPriority.Error:
			return "ERROR"
		case RuntimeEventPriority.Invariant:
			return "FATAL"
	}
}

/**
 * Recovers the internal priority from a severity number.
 *
 * Needed by the eviction processor, which runs after events have already been
 * translated but still has to decide what to shed first.
 */
export function fromSeverityNumber(severity: SeverityNumber): RuntimeEventPriority {
	if (severity >= SeverityNumber.FATAL) return RuntimeEventPriority.Invariant
	if (severity >= SeverityNumber.ERROR) return RuntimeEventPriority.Error
	if (severity >= SeverityNumber.WARN) return RuntimeEventPriority.PerformanceAnomaly
	if (severity >= SeverityNumber.INFO) return RuntimeEventPriority.Info
	return RuntimeEventPriority.Debug
}

/** Milliseconds since the epoch expressed as OTLP nanoseconds. */
export function toUnixNano(timestampMs: number): bigint {
	return BigInt(Math.trunc(timestampMs)) * 1_000_000n
}

/**
 * A log record in the shape the OTLP JSON encoding expects.
 *
 * Timestamps are strings because nanosecond values exceed
 * `Number.MAX_SAFE_INTEGER`; emitting them as JSON numbers would silently
 * corrupt them.
 */
export interface OtlpLogRecord {
	readonly timeUnixNano: string
	readonly observedTimeUnixNano: string
	readonly traceId?: string
	readonly spanId?: string
	readonly flags?: number
	readonly severityNumber: number
	readonly severityText: string
	readonly body: { readonly stringValue: string }
	readonly attributes: readonly OtlpKeyValue[]
}

export interface OtlpKeyValue {
	readonly key: string
	readonly value: OtlpAnyValue
}

export type OtlpAnyValue =
	| { readonly stringValue: string }
	| { readonly intValue: string }
	| { readonly doubleValue: number }
	| { readonly boolValue: boolean }

/**
 * Boxes a scalar into the OTLP `AnyValue` union.
 *
 * Integers are encoded as strings for the same reason timestamps are: the
 * protobuf type is 64-bit and JSON numbers are not.
 */
export function toAnyValue(value: string | number | boolean): OtlpAnyValue {
	if (typeof value === "boolean") return { boolValue: value }
	if (typeof value === "string") return { stringValue: value }
	return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
}

/**
 * Builds the attribute set for one event.
 *
 * The session id is deliberately absent: it identifies the extension host run,
 * which is a resource-level fact. Repeating it on every record would inflate
 * every payload and misrepresent it as an event-level dimension.
 */
export function toLogAttributes(event: RuntimeTelemetryEvent): LogAttributes {
	const attributes: Record<string, AnyValue> = {
		...event.attributes,
		[RUNTIME_ATTRIBUTE_KEYS.sequence]: event.sequence,
		[RUNTIME_ATTRIBUTE_KEYS.eventId]: event.eventId,
		[RUNTIME_ATTRIBUTE_KEYS.monotonicMs]: event.monotonicMs,
	}

	const { taskId, controllerId, workspaceId } = event.context
	if (taskId !== undefined) {
		attributes[RUNTIME_ATTRIBUTE_KEYS.taskId] = RuntimeContentPolicy.forEvents().apply({ taskId }).attributes.taskId
	}
	if (controllerId !== undefined) attributes[RUNTIME_ATTRIBUTE_KEYS.controllerId] = TELEMETRY_MASK_VALUE
	if (workspaceId !== undefined) attributes[RUNTIME_ATTRIBUTE_KEYS.workspaceId] = TELEMETRY_MASK_VALUE

	if (event.error) Object.assign(attributes, exceptionAttributes(event.error))

	return attributes
}

/**
 * Renders one event as an OTLP log record.
 *
 * `observedTimeUnixNano` equals `timeUnixNano` because the bus stamps events as
 * it admits them; there is no separate observation step that could drift.
 */
export function isWarningEvent(event: RuntimeTelemetryEvent): boolean {
	return event.attributes.logger_level === "warn" || event.attributes.message_level === "warning"
}

export function toOtlpLogRecord(event: RuntimeTelemetryEvent): OtlpLogRecord {
	const unixNano = toUnixNano(event.timestamp).toString()
	const attributes = toLogAttributes(event)

	return {
		timeUnixNano: unixNano,
		observedTimeUnixNano: unixNano,
		...(event.traceContext
			? { traceId: event.traceContext.traceId, spanId: event.traceContext.spanId, flags: event.traceContext.traceFlags }
			: {}),
		severityNumber: isWarningEvent(event) ? SeverityNumber.WARN : toSeverityNumber(event.priority),
		severityText: isWarningEvent(event) ? "WARN" : toSeverityText(event.priority),
		body: { stringValue: event.name },
		attributes: Object.entries(attributes).map(([key, value]) => ({
			key,
			value: toAnyValue(value as string | number | boolean),
		})),
	}
}
