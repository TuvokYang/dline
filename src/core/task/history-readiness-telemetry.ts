import { Logger } from "@shared/services/Logger"
import { type PerfPhaseHandle, startPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"

export const HISTORY_READINESS_STAGES = [
	"history_surface_preparing",
	"history_display",
	"history_message_surface",
	"history_watcher",
	"history_metrics",
	"history_reconciliation",
	"history_background_prepare",
	"history_surface_ready",
	"history_interaction_ready",
] as const

export type HistoryReadinessStage = (typeof HISTORY_READINESS_STAGES)[number]
export type HistoryReadinessOutcome = "success" | "failure" | "superseded" | "degraded"

/** Start one bounded history-readiness duration without putting Task identity into metric dimensions. */
export function startHistoryReadinessStage(taskId: string, stage: HistoryReadinessStage, hasTaskLock: boolean): PerfPhaseHandle {
	const measurement = startPerfPhase(PerfDomain.TaskInit, "stage", { stage, kind: "history", hasTaskLock }, { taskId })
	if (!Logger.isDebugEnabled()) return measurement

	const startedAt = performance.now()
	Logger.debug(`[TaskInitPerf] phase=${stage} state=start taskId=${taskId} kind=history hasTaskLock=${hasTaskLock}`)
	let stopped = false
	return {
		active: measurement.active,
		stop(dimensions): void {
			if (stopped) return
			stopped = true
			measurement.stop(dimensions)
			const outcome = typeof dimensions?.outcome === "string" ? ` outcome=${dimensions.outcome}` : ""
			Logger.debug(
				`[TaskInitPerf] phase=${stage} state=complete taskId=${taskId} kind=history hasTaskLock=${hasTaskLock} durationMs=${Math.round(performance.now() - startedAt)}${outcome}`,
			)
		},
	}
}
