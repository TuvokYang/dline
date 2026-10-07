import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "@core/task/performance/task-rate-metrics-types"
import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import {
	GetTaskRateMetricsRequest,
	TaskRateMetricsResolution,
	TaskRateRoundStatus,
	TaskRateRpmBasis,
	TaskRateTokenQuality,
	TaskRateUsageQuality,
} from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import { getTaskRateMetrics } from "../getTaskRateMetrics"
import { type DisplayedRateMetricsSource, selectTaskRateMetricsQuery } from "../TaskRateMetricsSource"

interface RateMetricsTask {
	taskId: string
	queryTaskRateMetrics(query: TaskRateMetricsQuery): Promise<TaskRateMetricsQueryResult>
}

/** Resolve through the Controller's selector so the handler sees the production running/History precedence. */
function controller(task?: RateMetricsTask, displayed?: DisplayedRateMetricsSource) {
	const running = task
		? createSessionFixture({ taskId: task.taskId, owners: { queryRateMetrics: task.queryTaskRateMetrics } })
		: undefined
	return {
		task: running,
		resolveTaskRateMetricsQuery: (taskId: string) => selectTaskRateMetricsQuery(taskId, running, displayed),
	}
}

function emptyResult(): TaskRateMetricsQueryResult {
	return { points: [], degraded: false, truncated: false }
}

function request(overrides: Partial<GetTaskRateMetricsRequest> = {}): GetTaskRateMetricsRequest {
	return GetTaskRateMetricsRequest.create({
		taskId: "task-1",
		resolution: TaskRateMetricsResolution.TASK_RATE_METRICS_RESOLUTION_HOUR,
		startMs: 1_500,
		endMs: 61_001,
		maxPoints: 24,
		...overrides,
	})
}

describe("getTaskRateMetrics", () => {
	it("maps a Round query and preserves zero-valued optional usage with duration metadata", async () => {
		const queryTaskRateMetrics = vi.fn(
			async (): Promise<TaskRateMetricsQueryResult> => ({
				points: [
					{
						bucketStartMs: 3_000,
						bucketEndMs: 3_001,
						requestCount: 1,
						tokenCount: 120,
						requestsPerMinute: 30,
						tokenQuality: "exact",
						inputTokens: 100,
						outputTokens: 20,
						thoughtsTokens: 0,
						cacheWriteTokens: 0,
						cacheReadTokens: 0,
						cacheHitRate: 0,
						cacheUsageAvailable: true,
						usageAvailable: true,
						providerDurationMs: 2_000,
						providerRoundCount: 1,
						completedRoundCount: 1,
						failedRoundCount: 0,
						cancelledRoundCount: 0,
						abortedRoundCount: 0,
						rpmBasis: "provider_duration",
						usageQuality: "exact",
						status: "completed",
						roundId: "round-1",
						logicalRequestId: "request-1",
						apiIndex: 0,
						taskAttempt: 0,
						providerAttempt: 0,
						startedAtMs: 1_000,
						completedAtMs: 3_000,
						totalCost: 0,
						currency: "USD",
					},
				],
				degraded: true,
				truncated: true,
				retentionStartMs: 3_000,
			}),
		)

		const response = await getTaskRateMetrics(
			controller({ taskId: "task-1", queryTaskRateMetrics }) as never,
			request({ resolution: TaskRateMetricsResolution.TASK_RATE_METRICS_RESOLUTION_ROUND, maxPoints: 60 }),
		)

		expect(queryTaskRateMetrics).toHaveBeenCalledOnce()
		expect(queryTaskRateMetrics).toHaveBeenCalledWith({
			resolution: "round",
			startMs: 1_500,
			endMs: 61_001,
			maxPoints: 60,
		})
		expect(response).toMatchObject({
			degraded: true,
			truncated: true,
			retentionStartMs: 3_000,
			points: [
				{
					cacheHitRate: 0,
					cacheUsageAvailable: true,
					usageAvailable: true,
					providerDurationMs: 2_000,
					rpmBasis: TaskRateRpmBasis.TASK_RATE_RPM_BASIS_PROVIDER_DURATION,
					usageQuality: TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_EXACT,
					status: TaskRateRoundStatus.TASK_RATE_ROUND_STATUS_COMPLETED,
					tokenQuality: TaskRateTokenQuality.TASK_RATE_TOKEN_QUALITY_EXACT,
					roundId: "round-1",
					apiIndex: 0,
					totalCost: 0,
				},
			],
		})
	})

	it("maps complete-execution RPM fields and preserves zero-valued optional duration", async () => {
		const queryTaskRateMetrics = vi.fn(
			async (): Promise<TaskRateMetricsQueryResult> => ({
				points: [
					{
						bucketStartMs: 5_000,
						bucketEndMs: 60_000,
						requestsPerMinute: 12,
						cacheUsageAvailable: false,
						usageAvailable: false,
						executionDurationMs: 0,
						executionCount: 5,
						completedExecutionCount: 1,
						failedExecutionCount: 1,
						cancelledExecutionCount: 1,
						abortedExecutionCount: 2,
						providerRoundCount: 0,
						completedRoundCount: 0,
						failedRoundCount: 0,
						cancelledRoundCount: 0,
						abortedRoundCount: 0,
						rpmBasis: "execution_duration",
						usageQuality: "none",
					},
				],
				degraded: false,
				truncated: false,
			}),
		)

		const response = await getTaskRateMetrics(
			controller({ taskId: "task-1", queryTaskRateMetrics }) as never,
			request({ resolution: TaskRateMetricsResolution.TASK_RATE_METRICS_RESOLUTION_MINUTE }),
		)

		expect(response.points[0]).toMatchObject({
			requestsPerMinute: 12,
			executionDurationMs: 0,
			executionCount: 5,
			completedExecutionCount: 1,
			failedExecutionCount: 1,
			cancelledExecutionCount: 1,
			abortedExecutionCount: 2,
			rpmBasis: TaskRateRpmBasis.TASK_RATE_RPM_BASIS_EXECUTION_DURATION,
		})
	})

	it("maps legacy usage quality without inventing Provider duration", async () => {
		const queryTaskRateMetrics = vi.fn(
			async (): Promise<TaskRateMetricsQueryResult> => ({
				points: [
					{
						bucketStartMs: 1_000,
						bucketEndMs: 1_001,
						requestCount: 1,
						tokenCount: 120,
						tokenQuality: "estimated",
						inputTokens: 100,
						outputTokens: 20,
						cacheUsageAvailable: false,
						usageAvailable: true,
						providerRoundCount: 0,
						completedRoundCount: 1,
						failedRoundCount: 0,
						cancelledRoundCount: 0,
						abortedRoundCount: 0,
						rpmBasis: "unavailable",
						usageQuality: "legacy",
						status: "completed",
						roundId: "legacy-round-1",
						logicalRequestId: "legacy-ui:1000",
						apiIndex: 0,
						taskAttempt: 0,
						providerAttempt: 0,
						startedAtMs: 1_000,
						completedAtMs: 1_000,
					},
				],
				degraded: false,
				truncated: false,
			}),
		)

		const response = await getTaskRateMetrics(
			controller({ taskId: "task-1", queryTaskRateMetrics }) as never,
			request({ resolution: TaskRateMetricsResolution.TASK_RATE_METRICS_RESOLUTION_ROUND }),
		)

		expect(response.points[0]?.usageQuality).toBe(TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_LEGACY)
		expect(response.points[0]?.providerDurationMs).toBeUndefined()
	})

	it("rejects a query when no Task is active", async () => {
		await expect(getTaskRateMetrics(controller() as never, request())).rejects.toThrow("active Task")
	})

	it("rejects a query for a different Task without reading its metrics", async () => {
		const queryTaskRateMetrics = vi.fn(
			async (): Promise<TaskRateMetricsQueryResult> => ({
				points: [],
				degraded: false,
				truncated: false,
			}),
		)

		await expect(
			getTaskRateMetrics(controller({ taskId: "task-1", queryTaskRateMetrics }) as never, request({ taskId: "task-2" })),
		).rejects.toThrow("active Task")
		expect(queryTaskRateMetrics).not.toHaveBeenCalled()
	})

	it("answers a task viewed from History with the metrics its last run recorded", async () => {
		const queryRateMetrics = vi.fn(async (): Promise<TaskRateMetricsQueryResult> => emptyResult())

		const response = await getTaskRateMetrics(
			controller(undefined, { taskId: "task-1", queryRateMetrics }) as never,
			request({ resolution: TaskRateMetricsResolution.TASK_RATE_METRICS_RESOLUTION_MINUTE }),
		)

		expect(queryRateMetrics).toHaveBeenCalledWith({ resolution: "minute", startMs: 1_500, endMs: 61_001, maxPoints: 24 })
		expect(response.points).toEqual([])
	})

	it("rejects a running task whose metrics owner is not open yet", async () => {
		const running = createSessionFixture({ taskId: "task-1", owners: { queryRateMetrics: undefined } })
		const pending = {
			task: running,
			resolveTaskRateMetricsQuery: (taskId: string) => selectTaskRateMetricsQuery(taskId, running, undefined),
		}

		await expect(getTaskRateMetrics(pending as never, request())).rejects.toThrow("initialized metrics owner")
	})

	it("rejects a History view whose task never recorded metrics", async () => {
		await expect(
			getTaskRateMetrics(
				controller(undefined, { taskId: "task-1", queryRateMetrics: () => undefined }) as never,
				request(),
			),
		).rejects.toThrow("no recorded rate metrics")
	})

	it("prefers the running task over a History view of another task", async () => {
		const runningQuery = vi.fn(async (): Promise<TaskRateMetricsQueryResult> => emptyResult())
		const displayedQuery = vi.fn(async (): Promise<TaskRateMetricsQueryResult> => emptyResult())

		await getTaskRateMetrics(
			controller(
				{ taskId: "task-1", queryTaskRateMetrics: runningQuery },
				{ taskId: "task-2", queryRateMetrics: displayedQuery },
			) as never,
			request(),
		)
		await expect(
			getTaskRateMetrics(
				controller(
					{ taskId: "task-1", queryTaskRateMetrics: runningQuery },
					{ taskId: "task-2", queryRateMetrics: displayedQuery },
				) as never,
				request({ taskId: "task-3" }),
			),
		).rejects.toThrow("active Task")

		expect(runningQuery).toHaveBeenCalledOnce()
		expect(displayedQuery).not.toHaveBeenCalled()
	})

	it("rejects an unspecified resolution before querying persistence", async () => {
		const queryTaskRateMetrics = vi.fn(
			async (): Promise<TaskRateMetricsQueryResult> => ({
				points: [],
				degraded: false,
				truncated: false,
			}),
		)

		await expect(
			getTaskRateMetrics(
				controller({ taskId: "task-1", queryTaskRateMetrics }) as never,
				request({ resolution: TaskRateMetricsResolution.TASK_RATE_METRICS_RESOLUTION_UNSPECIFIED }),
			),
		).rejects.toThrow("resolution")
		expect(queryTaskRateMetrics).not.toHaveBeenCalled()
	})

	it("rejects an empty time range before querying persistence", async () => {
		const queryTaskRateMetrics = vi.fn(
			async (): Promise<TaskRateMetricsQueryResult> => ({
				points: [],
				degraded: false,
				truncated: false,
			}),
		)

		await expect(
			getTaskRateMetrics(
				controller({ taskId: "task-1", queryTaskRateMetrics }) as never,
				request({ startMs: 10_000, endMs: 10_000 }),
			),
		).rejects.toThrow("time range")
		expect(queryTaskRateMetrics).not.toHaveBeenCalled()
	})
})
