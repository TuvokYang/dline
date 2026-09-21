import type { TaskViewState } from "@shared/ExtensionMessage"
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
			await options.onPreparingToDisplay?.()
			span.addEvent?.("task.history_prepare.preparing")
			if (!options.isCurrent()) return finish(false)

			await options.displayHistory()
			span.addEvent?.("task.history_prepare.displayed")
			if (!options.isCurrent()) return finish(false)

			let readyNotified = false
			const notifyReady = async (): Promise<void> => {
				if (readyNotified || !options.isCurrent()) return
				readyNotified = true
				await options.onReadyToDisplay?.()
				span.addEvent?.("task.history_prepare.ready")
			}
			if (!options.hasTaskLock) {
				await notifyReady()
				return finish(options.isCurrent())
			}

			await options.prepareFromHistory({
				isCurrent: options.isCurrent,
				onReadyToDisplay: notifyReady,
			})
			span.addEvent?.("task.history_prepare.prepared")
			return finish(options.isCurrent())
		} catch (error) {
			span.recordException(error)
			span.end("failure")
			throw error
		}
	})

	function finish(current: boolean): boolean {
		span.setAttribute("current", current)
		span.end("success")
		return current
	}
}
