import type { TaskRateMetricsQuery, TaskRateMetricsQueryResult } from "@core/task/performance/task-rate-metrics-types"
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

interface RateMetricsTask {
	taskId: string
	taskInstanceId?: string
	queryTaskRateMetrics(query: TaskRateMetricsQuery): Promise<TaskRateMetricsQueryResult>
}

function controller(task?: RateMetricsTask): { task?: RateMetricsTask } {
	return task ? { task: { taskInstanceId: "open-1", ...task } } : {}
}

function request(overrides: Partial<GetTaskRateMetricsRequest> = {}): GetTaskRateMetricsRequest {
	return GetTaskRateMetricsRequest.create({
		taskId: "task-1",
		taskInstanceId: "open-1",
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

	it("rejects a query when no Task is open", async () => {
		await expect(getTaskRateMetrics(controller() as never, request())).rejects.toThrow("opened Task instance")
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
		).rejects.toThrow("opened Task instance")
		expect(queryTaskRateMetrics).not.toHaveBeenCalled()
	})

	it("rejects a request from a previous opening of the same Task before reading", async () => {
		const queryTaskRateMetrics = vi.fn()
		await expect(
			getTaskRateMetrics(
				controller({ taskId: "task-1", queryTaskRateMetrics }) as never,
				request({ taskInstanceId: "previous-open" }),
			),
		).rejects.toThrow("opened Task instance")
		expect(queryTaskRateMetrics).not.toHaveBeenCalled()
	})

	it.each(["closed", "reopened"])("discards a query completed after its Task is %s", async (replacement) => {
		let resolve!: (value: TaskRateMetricsQueryResult) => void
		const queryTaskRateMetrics = vi.fn(
			() =>
				new Promise<TaskRateMetricsQueryResult>((done) => {
					resolve = done
				}),
		)
		const owner = controller({ taskId: "task-1", queryTaskRateMetrics })
		const pending = getTaskRateMetrics(owner as never, request())
		owner.task =
			replacement === "closed" ? undefined : { taskId: "task-1", taskInstanceId: "open-2", queryTaskRateMetrics: vi.fn() }
		resolve({ points: [], degraded: false, truncated: false })
		await expect(pending).rejects.toThrow("opened Task instance")
	})

	it.each(["PAUSED", "COMPLETED"])("reads the exact open owner in %s without activating it", async (phase) => {
		const queryTaskRateMetrics = vi.fn().mockResolvedValue({ points: [], degraded: false, truncated: false })
		const owner = { ...controller({ taskId: "task-1", queryTaskRateMetrics }).task!, phase }
		const result = await getTaskRateMetrics({ task: owner } as never, request())
		expect(result).toMatchObject({ taskId: "task-1", taskInstanceId: "open-1", points: [] })
		expect(owner.phase).toBe(phase)
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
