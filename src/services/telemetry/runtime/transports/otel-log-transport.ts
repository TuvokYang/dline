import { ROOT_CONTEXT, trace } from "@opentelemetry/api"
import { type Logger as OtelLogger, SeverityNumber } from "@opentelemetry/api-logs"
import { BatchLogRecordProcessor, type LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs"
import { RUNTIME_SCOPE_NAME, RUNTIME_SCOPE_VERSION } from "@/services/telemetry/otel/scopes"
import {
	attachScopedProcessors,
	configureSharedTelemetryResource,
	detachScope,
} from "@/services/telemetry/otel/shared-logger-provider"
import { createOTLPLogExporter } from "@/services/telemetry/providers/opentelemetry/OpenTelemetryExporterFactory"
import { epochMillisecondsToHrTime } from "../../otel/log-record"
import { isWarningEvent, toLogAttributes, toSeverityNumber, toSeverityText } from "../otel-semantics"
import type { RuntimeTelemetryEvent } from "../types"
import { ContentPolicyProcessor } from "./content-policy-processor"

/**
 * Ships runtime telemetry through the OpenTelemetry SDK.
 *
 * This replaces a hand-written transport that posted `{ events: [...] }` to
 * `/v1/logs`. That payload was not OTLP, so no collector could read it: the
 * endpoint looked standard while the body was private, and every consumer would
 * have needed a bespoke adapter. Batching, queue limits, export timeouts and
 * retry are the SDK's job here, not ours.
 *
 * The exporter comes from the shared factory rather than being constructed
 * directly, because that factory is where the project's proxy and certificate
 * configuration is applied. Bypassing it would silently break every host that
 * needs a proxy.
 */

/** Default local collector, per the WS-017 transport contract. */
const DEFAULT_ENDPOINT = "http://127.0.0.1:4318"

/**
 * Identifies this transport's registration on the shared provider.
 *
 * Only one runtime pipeline runs per host, so a constant is sufficient, and it
 * makes a restart replace the previous registration instead of stacking a
 * second one beside it.
 */
const ROUTE_OWNER_ID = "runtime-telemetry"

/** Matches the previous transport so queue pressure behaves the same. */
const DEFAULT_MAX_QUEUE_SIZE = 1_000
const DEFAULT_MAX_EXPORT_BATCH_SIZE = 64
const DEFAULT_SCHEDULED_DELAY_MS = 5_000
const DEFAULT_EXPORT_TIMEOUT_MS = 3_000

export interface OtelLogTransportOptions {
	readonly sessionId: string
	readonly endpoint?: string
	/** `http/protobuf`, `http/json` or `grpc`; defaults to `http/protobuf`. */
	readonly protocol?: string
	readonly headers?: Record<string, string>
	/** Present for parity with the previous contract; unused by the local collector. */
	readonly token?: string
	readonly maxQueueSize?: number
	readonly maxExportBatchSize?: number
	readonly scheduledDelayMs?: number
	readonly exportTimeoutMs?: number
	/**
	 * Replaces the export processor.
	 *
	 * Tests need to observe emitted records without running a collector, and
	 * the SDK ships in-memory processors for exactly that. Returning undefined
	 * attaches nothing, which is how a test asserts that no export happens.
	 */
	readonly processorFactory?: () => LogRecordProcessor | undefined
}

export interface OtelLogTransportStats {
	/** Events synchronously admitted to the OTel logger; not proof of collector delivery. */
	readonly sentEvents: number
	/** Local emit/flush operations that threw; exporter callback failures use delivery accounting. */
	readonly failedBatches: number
	/** Events rejected because this compatibility transport was inert or already disposed. */
	readonly droppedEvents: number
}

export class OtelLogTransport {
	private readonly provider: LoggerProvider | undefined
	private readonly logger: OtelLogger | undefined
	/** This scope's processors; owned here because the provider is not. */
	private processors: LogRecordProcessor[] = []

	private sentEvents = 0
	private failedBatches = 0
	private droppedEvents = 0
	private disposed = false

	constructor(options: OtelLogTransportOptions) {
		// The session identifies this extension host run, which is a property
		// of the producing resource rather than of any single record. It is
		// published before the first attach because the SDK binds the resource
		// when the provider is constructed.
		configureSharedTelemetryResource({ sessionId: options.sessionId })

		const processors = this.createProcessors(options)
		if (processors.length === 0) {
			// Nothing can export, so the transport stays inert rather than
			// attaching an empty scope and holding a logger that goes nowhere.
			return
		}

		this.provider = attachScopedProcessors(RUNTIME_SCOPE_NAME, ROUTE_OWNER_ID, processors)
		this.logger = this.provider.getLogger(RUNTIME_SCOPE_NAME, RUNTIME_SCOPE_VERSION)
	}

	get stats(): OtelLogTransportStats {
		return { sentEvents: this.sentEvents, failedBatches: this.failedBatches, droppedEvents: this.droppedEvents }
	}

	/**
	 * Hand one event to the SDK.
	 *
	 * Emission is synchronous and non-blocking: the processor buffers and the
	 * exporter runs on its own schedule, so `sentEvents` records SDK admission,
	 * not collector delivery. Export outcomes are counted at the exporter callback.
	 */
	enqueue(event: RuntimeTelemetryEvent): void {
		if (this.disposed || !this.logger) {
			this.droppedEvents += 1
			return
		}

		try {
			this.logger.emit({
				timestamp: epochMillisecondsToHrTime(event.timestamp),
				observedTimestamp: epochMillisecondsToHrTime(Date.now()),
				context: event.traceContext ? trace.setSpanContext(ROOT_CONTEXT, event.traceContext) : ROOT_CONTEXT,
				severityNumber: isWarningEvent(event) ? SeverityNumber.WARN : toSeverityNumber(event.priority),
				severityText: isWarningEvent(event) ? "WARN" : toSeverityText(event.priority),
				body: event.name,
				attributes: toLogAttributes(event),
			})
			this.sentEvents += 1
		} catch {
			// Reporting must never fail the operation being reported.
			this.failedBatches += 1
		}
	}

	/** Export everything buffered. Never rejects. */
	async flush(): Promise<void> {
		if (this.disposed || !this.provider) return
		try {
			await this.provider.forceFlush()
		} catch {
			this.failedBatches += 1
		}
	}

	async dispose(): Promise<void> {
		if (this.disposed) return
		this.disposed = true
		if (!this.provider) return

		try {
			// The provider is shared, so shutting it down here would silence
			// product analytics too. Flushing first and then detaching stops
			// this scope without disturbing anything else attached to it.
			await this.provider.forceFlush()
		} catch {
			this.failedBatches += 1
		} finally {
			detachScope(RUNTIME_SCOPE_NAME, ROUTE_OWNER_ID)
			// The scope's own processors are this transport's to close; the
			// router no longer references them after the detach above.
			await Promise.all(this.processors.map((processor) => processor.shutdown().catch(() => undefined)))
		}
	}

	/**
	 * Builds this scope's processor chain, or an empty chain when nothing can
	 * export.
	 *
	 * A missing exporter is a normal outcome: the endpoint may be malformed or
	 * the protocol unsupported. Telemetry then degrades to the journal alone
	 * rather than throwing during activation.
	 */
	private createProcessors(options: OtelLogTransportOptions): LogRecordProcessor[] {
		const exporting = options.processorFactory ? options.processorFactory() : this.createBatchProcessor(options)
		if (!exporting) return []

		// Redaction is registered first: the router invokes processors in
		// order, and once a record is queued for export it can no longer be
		// rewritten, so a policy running afterwards would let raw content
		// reach the collector.
		this.processors = [new ContentPolicyProcessor(), exporting]
		return this.processors
	}

	private createBatchProcessor(options: OtelLogTransportOptions): LogRecordProcessor | undefined {
		const exporter = createOTLPLogExporter(
			options.protocol ?? "http/protobuf",
			options.endpoint ?? DEFAULT_ENDPOINT,
			// The default endpoint is loopback, where TLS is neither available
			// nor meaningful.
			true,
			options.headers,
			options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS,
		)
		if (!exporter) return undefined

		return new BatchLogRecordProcessor(exporter, {
			maxQueueSize: options.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE,
			maxExportBatchSize: options.maxExportBatchSize ?? DEFAULT_MAX_EXPORT_BATCH_SIZE,
			scheduledDelayMillis: options.scheduledDelayMs ?? DEFAULT_SCHEDULED_DELAY_MS,
			exportTimeoutMillis: options.exportTimeoutMs ?? DEFAULT_EXPORT_TIMEOUT_MS,
		})
	}
}
