import { Logger, type StructuredLogRecord } from "@/shared/services/Logger"
import { isTelemetryDevelopmentMode } from "../../development-mode"
import { TELEMETRY_MASK_VALUE } from "../../service/pipeline-port"
import { type ErrorEventRecorder, errorEventRecorder } from "./ErrorEventRecorder"

interface LoggerTelemetryBridgeOptions {
	readonly developmentMode?: boolean
}

/** Connect Logger warn/error records to the standard error Event recorder without recursion. */
export function installLoggerTelemetryBridge(
	recorder: ErrorEventRecorder = errorEventRecorder,
	options: LoggerTelemetryBridgeOptions = {},
): () => void {
	const developmentMode = options.developmentMode ?? isTelemetryDevelopmentMode()
	let publishing = false
	return Logger.subscribeStructured((record: StructuredLogRecord) => {
		if (publishing) return
		publishing = true
		try {
			const metadata = {
				logger_message: TELEMETRY_MASK_VALUE,
				logger_level: record.level,
				logger_metadata: record.metadata,
				...(developmentMode
					? {
							diagnostic_logger_message: record.message,
							diagnostic_logger_args: record.args,
						}
					: undefined),
			}
			if (record.error) recorder.exception(record.error, metadata)
			else recorder.message(record.message, record.level === "warn" ? "warning" : "error", metadata)
		} finally {
			publishing = false
		}
	})
}
