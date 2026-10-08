import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "@core/task/performance/task-rate-metrics-types"

export type TaskRateMetricsQueryFn = (query: TaskRateMetricsQuery) => Promise<TaskRateMetricsQueryResult>

/** A running task publishes its metrics query through its owners once its metrics owner is open. */
export interface RunningRateMetricsSource {
	readonly taskId: string
	readonly owners: { readonly queryRateMetrics?: TaskRateMetricsQueryFn }
}

/** A read-only History view answers only when the task's last run recorded metrics. */
export interface DisplayedRateMetricsSource {
	readonly taskId: string
	queryRateMetrics(query: TaskRateMetricsQuery): Promise<TaskRateMetricsQueryResult> | undefined
}

/**
 * Select the rate history query for the task shown in a panel.
 *
 * The running task wins; otherwise a History view of the same task answers from
 * its recorded metrics.
 * @returns undefined when neither shown task matches `taskId`.
 */
export function selectTaskRateMetricsQuery(
	taskId: string,
	running: RunningRateMetricsSource | undefined,
	displayed: DisplayedRateMetricsSource | undefined,
): TaskRateMetricsQueryFn | undefined {
	if (running?.taskId === taskId) {
		return (
			running.owners.queryRateMetrics ??
			(() => Promise.reject(new Error("Task rate metrics query requires an initialized metrics owner")))
		)
	}
	if (displayed?.taskId !== taskId) return undefined
	return (query) => displayed.queryRateMetrics(query) ?? Promise.reject(new Error("Task has no recorded rate metrics"))
}
