import { trace } from "@opentelemetry/api"
import { version as extensionVersion } from "../../../../package.json"
import { eventTimestamp, logRecordFields } from "../otel/log-record"
import type { JournalTelemetrySignal, TelemetryChannel, TelemetrySeverity } from "../providers/capabilities"
import { readBuildIdentity } from "../runtime/export/build-identity"
import type { CanonicalTelemetryProperties } from "../service/canonicalization"

export interface JournalRecordMetadata {
	readonly sessionId: string
	readonly sequence: number
	readonly channel: TelemetryChannel
	readonly signalKind: "event" | "metric" | "trace"
	readonly contentPolicy: CanonicalTelemetryProperties["contentPolicy"]
}

export interface JournalSpanRecord {
	readonly name: string
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId?: string
	readonly startTime: number
	readonly endTime: number
	readonly outcome: "success" | "failure" | "cancelled"
	readonly attributes: Readonly<Record<string, string | number | boolean>>
	readonly errorType?: string
	readonly errorFingerprint?: string
	readonly events?: readonly {
		name: string
		timestamp: number
		attributes: Readonly<Record<string, string | number | boolean>>
	}[]
}

export function projectEvent(
	signal: Extract<JournalTelemetrySignal, { kind: "event" }>,
	canonical: CanonicalTelemetryProperties,
	meta: JournalRecordMetadata,
): unknown {
	const fields = logRecordFields(signal.properties)
	const span = fields.context ? trace.getSpanContext(fields.context) : undefined
	return {
		resourceLogs: [
			{
				resource: resource(meta),
				scopeLogs: [
					{
						scope: { name: "dline.usage" },
						logRecords: [
							{
								timeUnixNano: unixNano(eventTimestamp(signal.properties)),
								observedTimeUnixNano: unixNano(Date.now()),
								...(span ? { traceId: span.traceId, spanId: span.spanId, flags: span.traceFlags } : {}),
								severityNumber: severityNumber(signal.severity),
								severityText: signal.severity.toUpperCase(),
								body: { stringValue: signal.name },
								attributes: attributes({ ...canonical.attributes, required: signal.required }),
							},
						],
					},
				],
			},
		],
	}
}

export function projectMetric(
	signal: Extract<JournalTelemetrySignal, { kind: "metric" }>,
	canonical: CanonicalTelemetryProperties,
	meta: JournalRecordMetadata,
): unknown {
	const dataPoint = {
		timeUnixNano: unixNano(Date.now()),
		attributes: attributes(canonical.attributes),
		...(signal.value === null ? {} : { asDouble: signal.value }),
	}
	const metric =
		signal.instrument === "gauge"
			? { name: signal.name, description: signal.description, gauge: { dataPoints: [dataPoint] } }
			: signal.instrument === "counter"
				? {
						name: signal.name,
						description: signal.description,
						sum: { aggregationTemporality: 2, isMonotonic: true, dataPoints: [dataPoint] },
					}
				: {
						name: signal.name,
						description: signal.description,
						histogram: {
							aggregationTemporality: 2,
							dataPoints:
								signal.value === null
									? []
									: [{ ...dataPoint, count: "1", sum: signal.value, bucketCounts: ["1"], explicitBounds: [] }],
						},
					}
	return {
		resourceMetrics: [
			{
				resource: resource(meta),
				scopeMetrics: [{ scope: { name: "dline.runtime" }, metrics: [metric] }],
			},
		],
	}
}

export function projectTrace(span: JournalSpanRecord, meta: JournalRecordMetadata): unknown {
	return {
		resourceSpans: [
			{
				resource: resource(meta),
				scopeSpans: [
					{
						scope: { name: "dline.runtime" },
						spans: [
							{
								traceId: span.traceId,
								spanId: span.spanId,
								...(span.parentSpanId ? { parentSpanId: span.parentSpanId } : {}),
								name: span.name,
								kind: 1,
								startTimeUnixNano: unixNano(span.startTime),
								endTimeUnixNano: unixNano(span.endTime),
								attributes: attributes({ ...span.attributes, outcome: span.outcome }),
								...(span.errorType
									? {
											events: [
												{
													timeUnixNano: unixNano(span.endTime),
													name: "exception",
													attributes: attributes({
														"exception.type": span.errorType,
														...(span.errorFingerprint
															? { "exception.fingerprint": span.errorFingerprint }
															: {}),
													}),
												},
											],
										}
									: {}),
								...(span.events
									? {
											events: span.events.map((event) => ({
												name: event.name,
												timeUnixNano: unixNano(event.timestamp),
												attributes: attributes(event.attributes),
											})),
										}
									: {}),
								status: {
									code: span.outcome === "success" ? 1 : 2,
									...(span.outcome === "cancelled" ? { message: "cancelled" } : {}),
								},
							},
						],
					},
				],
			},
		],
	}
}

function resource(meta: JournalRecordMetadata): unknown {
	const build = readBuildIdentity()
	return {
		attributes: attributes({
			"service.name": "dline",
			"service.version": extensionVersion,
			"dline.build.id": build.buildId,
			"dline.build.symbolicatable": build.symbolicatable,
			"dline.schema.version": 1,
			"dline.session.id": meta.sessionId,
			"service.instance.id": meta.sessionId,
			"process.pid": process.pid,
			"dline.sequence": meta.sequence,
			"dline.channel": meta.channel,
			"dline.signal.kind": meta.signalKind,
			"dline.content_policy.rejected_count": meta.contentPolicy.rejectedCount,
			"dline.content_policy.rejections": JSON.stringify(meta.contentPolicy.rejections),
		}),
	}
}

function attributes(values: Readonly<Record<string, string | number | boolean>>): unknown[] {
	return Object.entries(values).map(([key, value]) => ({ key, value: attributeValue(value) }))
}

function attributeValue(value: string | number | boolean): unknown {
	if (typeof value === "boolean") return { boolValue: value }
	if (typeof value === "number") return Number.isInteger(value) ? { intValue: String(value) } : { doubleValue: value }
	return { stringValue: value }
}

function unixNano(milliseconds: number): string {
	return BigInt(Math.max(0, Math.trunc(milliseconds * 1_000_000))).toString()
}

function severityNumber(severity: TelemetrySeverity): number {
	switch (severity) {
		case "debug":
			return 5
		case "info":
			return 9
		case "warn":
			return 13
		case "error":
			return 17
		case "fatal":
			return 21
	}
}
