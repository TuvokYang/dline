import type { HistoryResumeMaintenanceSummary } from "./history/HistoryResumeMaintenance"
import type { ResumeRecoverySummary } from "./resume/ResumeInput"

export type RecoveryTelemetryAttributes = Record<string, string | number | boolean>

/** Privacy-safe fixed attributes for one lazy history-open recovery. */
export function projectResumeRecoveryTelemetry(summary: ResumeRecoverySummary): RecoveryTelemetryAttributes {
	return {
		component: "task",
		operation: "history_recovery",
		source: summary.source,
		outcome: summary.outcome,
		...(summary.entryType === undefined ? {} : { entryType: summary.entryType }),
		...(summary.failureStage === undefined ? {} : { failureStage: summary.failureStage }),
		durationMs: summary.durationMs,
		diagnosticCount: summary.diagnosticCodes.length,
		diagnosticCodes: summary.diagnosticCodes.join(","),
		persistenceFailed: summary.persistenceFailed,
	}
}

/** Privacy-safe fixed attributes for post-admission historical maintenance. */
export function projectHistoryMaintenanceTelemetry(summary: HistoryResumeMaintenanceSummary): RecoveryTelemetryAttributes {
	return {
		component: "task",
		operation: "history_maintenance",
		source: summary.source,
		outcome: summary.outcome,
		durationMs: summary.durationMs,
		recoveredActivityCount: summary.recoveredActivityCount,
		commandCardPatchAttempted: summary.commandCardPatchAttempted,
		completedStageCount: summary.completedStageCount,
		failedStageCount: summary.failedStages.length,
		failedStages: summary.failedStages.join(","),
	}
}
