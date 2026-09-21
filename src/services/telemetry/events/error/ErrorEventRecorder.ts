import { formatDiagnosticArgument, redactDiagnosticString } from "@/shared/services/logging/safe-diagnostic-value"
import { isTelemetryDevelopmentMode } from "../../development-mode"
import { TELEMETRY_MASK_VALUE } from "../../service/pipeline-port"
import { type RuntimeEventRecorderPort, runtimeEventRecorder } from "../runtime"

export type ErrorMessageLevel = "error" | "warning" | "log" | "debug" | "info"

interface ErrorEventRecorderOptions {
	readonly developmentMode?: boolean
}

/** Standard error Event recorder shared by ErrorService and the Logger bridge. */
export class ErrorEventRecorder {
	private readonly developmentMode: boolean

	constructor(
		private readonly runtime: RuntimeEventRecorderPort = runtimeEventRecorder,
		options: ErrorEventRecorderOptions = {},
	) {
		this.developmentMode = options.developmentMode ?? isTelemetryDevelopmentMode()
	}

	exception(error: unknown, properties?: Readonly<Record<string, unknown>>): void {
		this.runtime.record({
			name: "extension.error",
			level: "error",
			error,
			attributes: {
				...properties,
				exception_message: TELEMETRY_MASK_VALUE,
				...(this.developmentMode ? { diagnostic_exception_message: this.safeExceptionMessage(error) } : undefined),
			},
		})
	}

	message(message: string, level: ErrorMessageLevel = "log", properties?: Readonly<Record<string, unknown>>): void {
		this.runtime.record({
			name: "extension.message",
			level: level === "error" || level === "warning" ? "error" : level === "debug" ? "debug" : "info",
			attributes: {
				...properties,
				message: TELEMETRY_MASK_VALUE,
				message_level: level,
				...(this.developmentMode ? { diagnostic_message: redactDiagnosticString(message) } : undefined),
			},
		})
	}

	private safeExceptionMessage(error: unknown): string {
		if (error instanceof Error) return redactDiagnosticString(error.message)
		if (typeof error === "string") return redactDiagnosticString(error)
		return formatDiagnosticArgument(error)
	}
}

export const errorEventRecorder = new ErrorEventRecorder()
