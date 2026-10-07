import type { TaskViewState } from "@shared/ExtensionMessage"
import {
	type HistoryReadinessOutcome,
	type HistoryReadinessStage,
	startHistoryReadinessStage,
} from "@/core/task/history-readiness-telemetry"
import { runWithSignalSpan, startSignalSpan } from "@/services/telemetry/service/pipeline-port"

export interface HistoryTaskReadinessOptions {
	taskId: string
	displayHistory: () => Promise<void>
	onPreparingToDisplay?: () => Promise<void>
	prepareFromHistory: (options: { onReadyToDisplay?: () => Promise<void>; isCurrent?: () => boolean }) => Promise<void>
	hasTaskLock: boolean
	isCurrent: () => boolean
	onReadyToDisplay?: () => Promise<void>
}

/** Project a visible but non-dispatchable Resume surface while canonical identity is restored. */
export function projectHistoryPreparingView(state: {
	taskId: string
	phase: TaskViewState["phase"]
	revision: number
}): TaskViewState {
	return {
		taskId: state.taskId,
		phase: state.phase,
		stateRevision: state.revision,
		input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
		footer: {
			actions: [
				{
					type: "resume",
					label: "Resume",
					appearance: "primary",
					enabled: false,
					payloadPolicy: "draft",
					dispatchTarget: "interaction",
				},
			],
		},
	}
}

/**
 * Loads one historical Task and preserves its identity across readiness effects.
 * Returns whether the same Task still owns the Controller surface.
 */
export async function prepareHistoryTaskForDisplay(options: HistoryTaskReadinessOptions): Promise<boolean> {
	const span = startSignalSpan({
		name: "task.history_prepare",
		root: true,
		attributes: { task_id: options.taskId, has_task_lock: options.hasTaskLock },
	})

	return runWithSignalSpan(span, async () => {
		try {
			await runStage("history_surface_preparing", async () => options.onPreparingToDisplay?.())
			span.addEvent?.("task.history_prepare.preparing")
			if (!options.isCurrent()) return finish(false)

			await runStage("history_display", options.displayHistory)
			span.addEvent?.("task.history_prepare.displayed")
			if (!options.isCurrent()) return finish(false)

			await runStage("history_surface_ready", async () => options.onReadyToDisplay?.())
			span.addEvent?.("task.history_prepare.ready")
			if (!options.isCurrent() || !options.hasTaskLock) return finish(options.isCurrent())

			await runStage("history_background_prepare", () =>
				options.prepareFromHistory({
					isCurrent: options.isCurrent,
				}),
			)
			span.addEvent?.("task.history_prepare.prepared")
			return finish(options.isCurrent())
		} catch (error) {
			// A detached or replaced Task aborts its own preparation; that is a superseded load, not a failure.
			if (!options.isCurrent()) return finish(false)
			span.recordException(error)
			span.end("failure")
			throw error
		}
	})

	async function runStage<T>(stage: HistoryReadinessStage, operation: () => Promise<T> | T): Promise<T> {
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

	function finish(current: boolean): boolean {
		span.setAttribute("current", current)
		span.end("success")
		return current
	}
}
