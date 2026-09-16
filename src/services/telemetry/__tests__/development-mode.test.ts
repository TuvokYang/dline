import { describe, expect, it } from "vitest"
import {
	isTelemetryDebugDiagnosticsEnabled,
	isTelemetryDevelopmentMode,
	telemetryDevelopmentModeMetadata,
} from "../development-mode"

describe("telemetry development-mode boundary", () => {
	it("parses development mode through the shared environment flag contract", () => {
		expect(isTelemetryDevelopmentMode("true")).toBe(true)
		expect(isTelemetryDevelopmentMode("1")).toBe(true)
		expect(isTelemetryDevelopmentMode("false")).toBe(false)
		expect(isTelemetryDevelopmentMode(undefined)).toBe(false)
	})

	it("enables exporter diagnostics for either explicit diagnostics or development mode", () => {
		expect(isTelemetryDebugDiagnosticsEnabled("true", "false")).toBe(true)
		expect(isTelemetryDebugDiagnosticsEnabled("false", "true")).toBe(true)
		expect(isTelemetryDebugDiagnosticsEnabled("false", "false")).toBe(false)
	})

	it("preserves the raw development metadata value without interpreting it as a telemetry level", () => {
		expect(telemetryDevelopmentModeMetadata("custom-dev-marker")).toBe("custom-dev-marker")
		expect(telemetryDevelopmentModeMetadata(undefined)).toBeUndefined()
	})
})
