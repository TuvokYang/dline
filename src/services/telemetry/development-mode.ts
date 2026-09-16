import { envFlagEnabled } from "@shared/env"

/** Single telemetry boundary for the host's development-mode environment contract. */
export function isTelemetryDevelopmentMode(value = process.env.IS_DEV): boolean {
	return envFlagEnabled(value)
}

/** Centralized exporter-debug contract: explicit diagnostics or development mode. */
export function isTelemetryDebugDiagnosticsEnabled(
	diagnosticsValue = process.env.TEL_DEBUG_DIAGNOSTICS,
	developmentValue = process.env.IS_DEV,
): boolean {
	return envFlagEnabled(diagnosticsValue) || isTelemetryDevelopmentMode(developmentValue)
}

/** Preserve the existing metadata value while keeping environment access centralized. */
export function telemetryDevelopmentModeMetadata(value = process.env.IS_DEV): string | undefined {
	return value
}
