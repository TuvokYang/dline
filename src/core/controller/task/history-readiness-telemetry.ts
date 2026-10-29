import { Logger } from "@shared/services/Logger"
import { type PerfPhaseHandle, startPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"

/**
 * Stages of opening a history task.
 *
 * `history_message_surface` is the first frame that carries the task's
 * messages; the other three bound the surface the user sees before anything
 * interactive is prepared.
 */
export const HISTORY_READINESS_STAGES = [
    "history_surface_preparing",
    "history_display",
    "history_message_surface",
    "history_surface_ready",
    "history_background_prepare",
] as const

export type HistoryReadinessStage = (typeof HISTORY_READINESS_STAGES)[number]
export type HistoryReadinessOutcome = "success" | "failure" | "superseded"

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

/** Time `operation` as `stage`, recording whether the task still owned the surface when it settled. */
export async function measureHistoryReadinessStage<T>(
    stage: HistoryReadinessStage,
    options: { readonly taskId: string; readonly hasTaskLock: boolean; readonly isCurrent: () => boolean },
    operation: () => Promise<T> | T,
): Promise<T> {
    const measurement = startHistoryReadinessStage(options.taskId, stage, options.hasTaskLock)
    try {
        const result = await operation()
        const outcome: HistoryReadinessOutcome = options.isCurrent() ? "success" : "superseded"
        measurement.stop({ outcome })
        return result
    } catch (error) {
        measurement.stop({ outcome: options.isCurrent() ? "failure" : "superseded" })
        throw error
    }
}
