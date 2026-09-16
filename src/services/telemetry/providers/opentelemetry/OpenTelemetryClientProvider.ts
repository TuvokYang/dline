import type { Resource } from "@opentelemetry/resources"
import { BatchLogRecordProcessor, type LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs"
import { MeterProvider, type MetricReader } from "@opentelemetry/sdk-metrics"
import { OpenTelemetryClientValidConfig } from "@/shared/services/config/otel-config"
import { Logger } from "@/shared/services/Logger"
import { isTelemetryDebugDiagnosticsEnabled } from "../../development-mode"
import { USAGE_SCOPE_NAME } from "../../otel/scopes"
import { attachScopedProcessors, detachScope } from "../../otel/shared-logger-provider"
import { createTelemetryResource } from "../../otel/telemetry-resource"
import {
	createConsoleLogExporter,
	createConsoleMetricReader,
	createOTLPLogExporter,
	createOTLPMetricReader,
} from "./OpenTelemetryExporterFactory"

/**
 * OpenTelemetry client provider.
 * Manages meter and logger providers for telemetry collection.
 */
let routeOwnerSequence = 0

export class OpenTelemetryClientProvider {
	readonly meterProvider: MeterProvider | null = null
	readonly loggerProvider: LoggerProvider | null = null
	private readonly config: OpenTelemetryClientValidConfig | null
	/**
	 * Distinguishes this client's registration from other collectors on the
	 * product scope; a user-configured and an organization-configured client
	 * can be active at once and must not evict each other.
	 */
	private readonly routeOwnerId = `otel-client-${++routeOwnerSequence}`
	/** Processors this client attached, and therefore this client must close. */
	private logProcessors: LogRecordProcessor[] = []

	constructor(config: OpenTelemetryClientValidConfig) {
		this.config = config
		const isDebugMode = isTelemetryDebugDiagnosticsEnabled()

		// Only log endpoint in debug mode (security: avoid exposing infrastructure details)
		if (isDebugMode) {
			Logger.debug("[OTEL DEBUG] ========== OpenTelemetry Initialization ==========")
			Logger.debug(`[OTEL DEBUG] Configuration:`)
			Logger.debug(`[OTEL DEBUG]   - Metrics Exporter: ${this.config.metricsExporter || "none"}`)
			Logger.debug(`[OTEL DEBUG]   - Logs Exporter: ${this.config.logsExporter || "none"}`)
			Logger.debug(`[OTEL DEBUG]   - OTLP Protocol: ${this.config.otlpProtocol || "grpc (default)"}`)

			Logger.debug(`[OTEL DEBUG]   - OTLP Endpoint: ${this.config.otlpEndpoint || "not set"}`)
			Logger.debug(`[OTEL DEBUG]   - OTLP Insecure: ${this.config.otlpInsecure || false}`)
			Logger.debug(`[OTEL DEBUG]   - Metric Export Interval: ${this.config.metricExportInterval || 60000}ms`)
		}

		if (isDebugMode && config.otlpHeaders) {
			const headerCount = Object.keys(config.otlpHeaders).length
			// In debug mode, show that headers are configured and their total length
			Logger.debug(`[OTEL DEBUG]   - OTLP Headers: ${headerCount} headers configured`)
			Logger.debug("[OTEL DEBUG] ================================================")
		}

		// One resource describes the whole extension host, so product
		// analytics and runtime diagnostics report the same service identity
		// instead of each inventing its own.
		const resource = createTelemetryResource()

		// Initialize metrics if configured
		if (this.config.metricsExporter) {
			this.meterProvider = this.createMeterProvider(resource)
		}

		// Initialize logs if configured
		if (this.config.logsExporter) {
			this.loggerProvider = this.createLoggerProvider(resource)
		}

		Logger.debug("[OTEL DEBUG] OpenTelemetry initialization complete")
	}

	private createMeterProvider(resource: Resource): MeterProvider {
		const exporters = this.config?.metricsExporter?.split(",").map((type) => type.trim()) ?? []
		const readers: MetricReader[] = []
		const interval = this.config?.metricExportInterval || 60000
		const timeout = Math.min(Math.floor(interval * 0.8), 30000)

		Logger.debug(`[OTEL] Creating MeterProvider with exporters: ${exporters.join(", ")}`)

		for (const exporterType of exporters) {
			try {
				switch (exporterType) {
					case "console": {
						const reader = createConsoleMetricReader(interval, timeout)
						readers.push(reader)
						Logger.debug(`[OTEL] Console metrics reader created (interval: ${interval}ms)`)
						break
					}
					case "otlp": {
						const protocol = this.config?.otlpMetricsProtocol || this.config?.otlpProtocol || "grpc"
						const endpoint = this.config?.otlpMetricsEndpoint || this.config?.otlpEndpoint
						const insecure = this.config?.otlpInsecure || false
						const headers = this.config?.otlpMetricsHeaders || this.config?.otlpHeaders

						if (endpoint) {
							const reader = createOTLPMetricReader(protocol, endpoint, insecure, interval, timeout, headers)
							if (reader) {
								readers.push(reader)
								Logger.debug(`[OTEL] OTLP metrics reader created (${protocol}, interval: ${interval}ms)`)
							}
						} else {
							Logger.warn("[OTEL] OTLP metrics exporter requires an endpoint")
						}
						break
					}
					default:
						Logger.warn(`[OTEL] Unknown metrics exporter type: ${exporterType}`)
				}
			} catch (error) {
				Logger.error(`[OTEL] Failed to create metrics exporter '${exporterType}':`, error)
			}
		}

		if (readers.length === 0) {
			Logger.warn("[OTEL] No metric readers were successfully created")
		}

		const meterProvider = new MeterProvider({
			resource,
			readers,
		})

		// Dline uses injected providers rather than process-global OTel state.
		Logger.debug(`[OTEL] MeterProvider initialized with ${readers.length} reader(s)`)

		return meterProvider
	}

	private createLoggerProvider(_resource: Resource): LoggerProvider {
		const exporters = this.config?.logsExporter?.split(",").map((type) => type.trim()) ?? []
		const processors: LogRecordProcessor[] = []

		Logger.debug(`[OTEL] Creating LoggerProvider with exporters: ${exporters.join(", ")}`)

		for (const exporterType of exporters) {
			try {
				let exporter = null

				switch (exporterType) {
					case "console":
						exporter = createConsoleLogExporter()
						Logger.debug("[OTEL] Console logs exporter created")
						break
					case "otlp": {
						const protocol = this.config?.otlpLogsProtocol || this.config?.otlpProtocol || "grpc"
						const endpoint = this.config?.otlpLogsEndpoint || this.config?.otlpEndpoint
						const insecure = this.config?.otlpInsecure || false
						const headers = this.config?.otlpLogsHeaders || this.config?.otlpHeaders

						if (endpoint) {
							exporter = createOTLPLogExporter(protocol, endpoint, insecure, headers)
							if (exporter) {
								Logger.debug(`[OTEL] OTLP logs exporter created (${protocol})`)
							}
						} else {
							Logger.warn("[OTEL] OTLP logs exporter requires an endpoint")
						}
						break
					}
					default:
						Logger.warn(`[OTEL] Unknown logs exporter type: ${exporterType}`)
				}

				if (exporter) {
					const batchConfig = {
						maxQueueSize: this.config?.logMaxQueueSize || 2048,
						maxExportBatchSize: this.config?.logBatchSize || 512,
						scheduledDelayMillis: this.config?.logBatchTimeout || 5000,
					}

					processors.push(new BatchLogRecordProcessor(exporter, batchConfig))
					this.logProcessors = processors

					Logger.debug(
						`[OTEL] Log batch processor configured: maxQueue=${batchConfig.maxQueueSize}, batchSize=${batchConfig.maxExportBatchSize}, timeout=${batchConfig.scheduledDelayMillis}ms`,
					)
				}
			} catch (error) {
				Logger.error(`[OTEL] Failed to create logs exporter '${exporterType}':`, error)
			}
		}

		// Attaching under the product scope keeps these exporters from
		// receiving runtime diagnostics: the router delivers a record only to
		// the scope that emitted it. Each client instance registers under its
		// own owner id so a second configured collector — an organization's,
		// say — does not displace the first.
		const loggerProvider = attachScopedProcessors(USAGE_SCOPE_NAME, this.routeOwnerId, processors)

		// Dline uses the shared scoped provider directly; global registration is
		// first-wins and cannot be safely rebound after a consent-driven restart.
		Logger.debug("[OTEL] LoggerProvider initialized")

		return loggerProvider
	}

	public async forceFlush(): Promise<void> {
		await Promise.all([this.meterProvider?.forceFlush(), ...this.logProcessors.map((processor) => processor.forceFlush())])
	}

	public async dispose(): Promise<void> {
		const promises: Promise<void>[] = []

		if (this.meterProvider) {
			promises.push(
				this.meterProvider.shutdown().catch((error) => {
					Logger.error("Error shutting down MeterProvider:", error)
				}),
			)
		}

		if (this.loggerProvider) {
			// The LoggerProvider is shared with runtime diagnostics, so
			// shutting it down here would silence a subsystem this client does
			// not own. Detaching this client's route and closing only its own
			// processors stops its export and leaves the rest running.
			detachScope(USAGE_SCOPE_NAME, this.routeOwnerId)
			for (const processor of this.logProcessors) {
				promises.push(
					processor.shutdown().catch((error) => {
						Logger.error("Error shutting down log processor:", error)
					}),
				)
			}
			this.logProcessors = []
		}

		await Promise.all(promises)
	}
}
