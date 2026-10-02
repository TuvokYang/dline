import { describe, expect, it } from "vitest"
import { projectHistoryMaintenanceTelemetry, projectResumeRecoveryTelemetry } from "./RecoveryTelemetry"

describe("RecoveryTelemetry", () => {
	it("projects an exact privacy-safe resume attribute allowlist", () => {
		const attributes = projectResumeRecoveryTelemetry({
			source: "history_open",
			outcome: "failed",
			entryType: "show_error_recovery",
			failureStage: "publish",
			durationMs: 12,
			diagnosticCodes: ["snapshot_rebuilt", "missing_identity"],
			persistenceFailed: true,
		})

		expect(Object.keys(attributes).sort()).toEqual([
			"component",
			"diagnosticCodes",
			"diagnosticCount",
			"durationMs",
			"entryType",
			"failureStage",
			"operation",
			"outcome",
			"persistenceFailed",
			"source",
		])
		expect(JSON.stringify(attributes)).not.toMatch(/taskId|path|content|command|interactionId|secret/i)
	})

	it("projects an exact privacy-safe maintenance attribute allowlist", () => {
		const attributes = projectHistoryMaintenanceTelemetry({
			source: "history_execution_prepare",
			outcome: "degraded",
			durationMs: 23,
			recoveredActivityCount: 2,
			commandCardPatchAttempted: true,
			completedStageCount: 4,
			failedStages: ["task metadata refresh"],
		})

		expect(Object.keys(attributes).sort()).toEqual([
			"commandCardPatchAttempted",
			"completedStageCount",
			"component",
			"durationMs",
			"failedStageCount",
			"failedStages",
			"operation",
			"outcome",
			"recoveredActivityCount",
			"source",
		])
		expect(JSON.stringify(attributes)).not.toMatch(/taskId|path|content|commandOutput|interactionId|secret/i)
	})
})
