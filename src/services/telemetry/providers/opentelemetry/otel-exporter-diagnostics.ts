/**
 * OpenTelemetry Exporter Diagnostic Utilities
 *
 * Provides minimal diagnostic logging for OTLP exporters when debug mode is enabled.
 * Enable with: TEL_DEBUG_DIAGNOSTICS=true or IS_DEV=true
 */

import type { ExportResult } from "@opentelemetry/core"
import type { LogRecordExporter, ReadableLogRecord } from "@opentelemetry/sdk-logs"
import type { PushMetricExporter, ResourceMetrics } from "@opentelemetry/sdk-metrics"
import { Logger } from "@/shared/services/Logger"

/**
 * Wraps a metrics exporter with minimal diagnostic logging
 */
export function wrapMetricsExporterWithDiagnostics(exporter: PushMetricExporter, protocol: string, endpoint: string): void {
	const originalExport = exporter.export.bind(exporter)
	let exportCount = 0

	exporter.export = (metrics: ResourceMetrics, resultCallback: (result: ExportResult) => void) => {
		exportCount++
		const startTime = Date.now()

		const wrappedCallback = (result: ExportResult) => {
			const elapsed = Date.now() - startTime
			const metricsCount = metrics.scopeMetrics.reduce((count, scope) => count + scope.metrics.length, 0)

			if (result.code === 0) {
				Logger.debug(
					`[OTEL METRICS] Export #${exportCount} OK - protocol=${protocol} url=${endpoint} count=${metricsCount} elapsed=${elapsed}ms`,
				)
			} else {
				Logger.debug(
					`[OTEL METRICS] Export #${exportCount} FAILED - protocol=${protocol} url=${endpoint} elapsed=${elapsed}ms error="${result.error?.message || "unknown"}"`,
				)
			}

			resultCallback(result)
		}

		try {
			originalExport(metrics, wrappedCallback)
		} catch (error) {
			const elapsed = Date.now() - startTime
			Logger.internalError(
				`[OTEL METRICS] Export #${exportCount} EXCEPTION - elapsed=${elapsed}ms error="${error instanceof Error ? error.message : String(error)}"`,
			)
			throw error
		}
	}
}

/**
 * Wraps a logs exporter with minimal diagnostic logging
 */
export function wrapLogsExporterWithDiagnostics(exporter: LogRecordExporter, protocol: string, endpoint: string): void {
	const originalExport = exporter.export.bind(exporter)
	let exportCount = 0

	exporter.export = (logs: ReadableLogRecord[], resultCallback: (result: ExportResult) => void) => {
		exportCount++
		const startTime = Date.now()

		const wrappedCallback = (result: ExportResult) => {
			const elapsed = Date.now() - startTime
			const logsCount = logs.length

			if (result.code === 0) {
				Logger.debug(
					`[OTEL LOGS] Export #${exportCount} OK - protocol=${protocol} url=${endpoint} count=${logsCount} elapsed=${elapsed}ms`,
				)
			} else {
				Logger.debug(
					`[OTEL LOGS] Export #${exportCount} FAILED - protocol=${protocol} url=${endpoint} elapsed=${elapsed}ms error="${result.error?.message || "unknown"}"`,
				)
			}

			resultCallback(result)
		}

		try {
			originalExport(logs, wrappedCallback)
		} catch (error) {
			const elapsed = Date.now() - startTime
			Logger.internalError(
				`[OTEL LOGS] Export #${exportCount} EXCEPTION - elapsed=${elapsed}ms error="${error instanceof Error ? error.message : String(error)}"`,
			)
			throw error
		}
	}
}
