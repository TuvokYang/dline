import {
	GetTaskRateMetricsRequest,
	type GetTaskRateMetricsResponse,
	TaskRateMetricsResolution as ProtoResolution,
} from "@shared/proto/dline/task"
import { useCallback, useEffect, useRef, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"
import {
	createTaskRateMetricsQueryWindow,
	fillTaskRateMetricsTimeline,
	type TaskRateMetricsResolution,
} from "./TaskRateMetricsTimeline"

export type { TaskRateMetricsResolution } from "./TaskRateMetricsTimeline"

export interface UseTaskRateMetricsOptions {
	taskId?: string
	taskInstanceId?: string
	resolution: TaskRateMetricsResolution
	enabled: boolean
}

export interface TaskRateMetricsQueryState {
	data?: GetTaskRateMetricsResponse
	loading: boolean
	error?: string
	refresh: () => void
}

const PROTO_RESOLUTIONS: Record<TaskRateMetricsResolution, ProtoResolution> = {
	minute: ProtoResolution.TASK_RATE_METRICS_RESOLUTION_MINUTE,
	hour: ProtoResolution.TASK_RATE_METRICS_RESOLUTION_HOUR,
	day: ProtoResolution.TASK_RATE_METRICS_RESOLUTION_DAY,
}

/** Load bounded Task-local rate history only while its dialog is open. */
export function useTaskRateMetrics({
	taskId,
	taskInstanceId,
	resolution,
	enabled,
}: UseTaskRateMetricsOptions): TaskRateMetricsQueryState {
	const [refreshVersion, setRefreshVersion] = useState(0)
	const requestKey = JSON.stringify([taskId, taskInstanceId, resolution, enabled, refreshVersion])
	const latestRequestKey = useRef(requestKey)
	latestRequestKey.current = requestKey
	const [state, setState] = useState<Omit<TaskRateMetricsQueryState, "refresh"> & { requestKey?: string }>({ loading: false })
	const refresh = useCallback(() => setRefreshVersion((version) => version + 1), [])

	useEffect(() => {
		let active = true
		const isCurrent = () => active && latestRequestKey.current === requestKey
		if (!enabled || !taskId || !taskInstanceId) {
			setState({ requestKey, loading: false })
			return () => {
				active = false
			}
		}

		const queryWindow = createTaskRateMetricsQueryWindow(resolution, Date.now())
		setState({ requestKey, loading: true })
		void TaskServiceClient.getTaskRateMetrics(
			GetTaskRateMetricsRequest.create({
				taskId,
				taskInstanceId,
				resolution: PROTO_RESOLUTIONS[resolution],
				startMs: queryWindow.startMs,
				endMs: queryWindow.endMs,
				maxPoints: queryWindow.maxPoints,
			}),
		)
			.then((data) => {
				if (!isCurrent()) return
				if (data.taskId !== taskId || data.taskInstanceId !== taskInstanceId) {
					throw new Error("API rate history response belongs to a different Task opening")
				}
				setState({
					requestKey,
					data: { ...data, points: fillTaskRateMetricsTimeline(data.points, queryWindow) },
					loading: false,
				})
			})
			.catch((error: unknown) => {
				if (!isCurrent()) return
				setState({
					requestKey,
					loading: false,
					error: error instanceof Error ? error.message : "Failed to load API rate history",
				})
			})
		return () => {
			active = false
		}
	}, [enabled, requestKey, resolution, taskId, taskInstanceId])

	// A new opening must not render old data even before the passive effect runs.
	if (state.requestKey !== requestKey) return { loading: Boolean(enabled && taskId && taskInstanceId), refresh }
	return { data: state.data, loading: state.loading, error: state.error, refresh }
}
