import { type PerfPhaseHandle, startPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"

export const HISTORY_READINESS_STAGES = [
	"history_surface_preparing",
	"history_display",
	"history_watcher",
	"history_metrics",
	"history_reconciliation",
	"history_surface_ready",
] as const

export type HistoryReadinessStage = (typeof HISTORY_READINESS_STAGES)[number]
export type HistoryReadinessOutcome = "success" | "failure" | "superseded" | "degraded"

/** Start one bounded history-readiness duration without putting Task identity into metric dimensions. */
export function startHistoryReadinessStage(taskId: string, stage: HistoryReadinessStage, hasTaskLock: boolean): PerfPhaseHandle {
	return startPerfPhase(PerfDomain.TaskInit, "stage", { stage, kind: "history", hasTaskLock }, { taskId })
}
