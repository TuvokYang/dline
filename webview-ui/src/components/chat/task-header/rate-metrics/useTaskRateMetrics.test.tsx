import { type GetTaskRateMetricsResponse, TaskRateMetricsResolution as ProtoResolution } from "@shared/proto/dline/task"
import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	type TaskRateMetricsResolution,
	type UseTaskRateMetricsOptions,
	useTaskRateMetrics as useRateMetrics,
} from "./useTaskRateMetrics"

function useTaskRateMetrics(options: UseTaskRateMetricsOptions) {
	return useRateMetrics({ taskInstanceId: "open-1", ...options })
}

const mocks = vi.hoisted(() => ({
	getTaskRateMetrics: vi.fn(),
}))

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		getTaskRateMetrics: mocks.getTaskRateMetrics,
	},
}))

const NOW_MS = Date.parse("2026-08-10T12:00:00.000Z")

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, reject, resolve }
}

function response(activeSeconds: number, bucketMs = 60_000): GetTaskRateMetricsResponse {
	const bucketEndMs = Math.floor(NOW_MS / bucketMs) * bucketMs
	return {
		taskId: "task-1",
		taskInstanceId: "open-1",
		points: [
			{
				bucketStartMs: bucketEndMs - bucketMs,
				bucketEndMs,
				activeSeconds,
				requestCount: 1,
				tokenCount: 100,
				requestsPerMinute: 60,
				tokensPerMinute: 6_000,
				tokenQuality: 2,
				provisional: false,
			},
		],
		degraded: false,
		truncated: false,
	}
}

beforeEach(() => {
	mocks.getTaskRateMetrics.mockReset()
	vi.spyOn(Date, "now").mockReturnValue(NOW_MS)
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe("useTaskRateMetrics", () => {
	it("does not query while the history dialog is closed", () => {
		renderHook(() => useTaskRateMetrics({ enabled: false, resolution: "minute", taskId: "task-1" }))
		expect(mocks.getTaskRateMetrics).not.toHaveBeenCalled()
	})

	it("queries at most 60 minutes and fills the complete window around active points", async () => {
		const activeResponse = response(4)
		const activePoint = activeResponse.points[0]
		if (!activePoint) throw new Error("Expected active response point")
		const earlierPoint = {
			...activePoint,
			bucketStartMs: activePoint.bucketStartMs - 2 * 60_000,
			bucketEndMs: activePoint.bucketEndMs - 2 * 60_000,
		}
		mocks.getTaskRateMetrics.mockResolvedValueOnce({
			...activeResponse,
			points: [earlierPoint, activePoint],
		})
		const { result } = renderHook(() => useTaskRateMetrics({ enabled: true, resolution: "minute", taskId: "task-1" }))

		expect(result.current.loading).toBe(true)
		await waitFor(() => expect(result.current.data?.points).toHaveLength(60))
		const timeline = result.current.data?.points ?? []
		expect(timeline[0]).toMatchObject({ providerRoundCount: 0, executionCount: 0 })
		expect(timeline[0]?.activeSeconds).toBeUndefined()
		expect(timeline.filter(({ activeSeconds }) => activeSeconds === 4)).toHaveLength(2)
		expect(timeline.find(({ bucketStartMs }) => bucketStartMs === earlierPoint.bucketEndMs)?.activeSeconds).toBeUndefined()
		expect(timeline.at(-1)?.activeSeconds).toBeUndefined()
		expect(mocks.getTaskRateMetrics).toHaveBeenCalledWith(
			expect.objectContaining({
				taskId: "task-1",
				resolution: ProtoResolution.TASK_RATE_METRICS_RESOLUTION_MINUTE,
				startMs: NOW_MS - 59 * 60 * 1_000,
				endMs: NOW_MS + 60 * 1_000,
				maxPoints: 60,
			}),
		)
	})

	it("does not query again when a parent rerenders for local view or chart state", async () => {
		mocks.getTaskRateMetrics.mockResolvedValueOnce(response(4))
		const { rerender } = renderHook(
			({ localSelection }: { localSelection: string }) => {
				void localSelection
				return useTaskRateMetrics({ enabled: true, resolution: "minute", taskId: "task-1" })
			},
			{ initialProps: { localSelection: "token-cache-line" } },
		)
		await waitFor(() => expect(mocks.getTaskRateMetrics).toHaveBeenCalledTimes(1))

		rerender({ localSelection: "rates-bar" })
		rerender({ localSelection: "token-cache-line" })
		expect(mocks.getTaskRateMetrics).toHaveBeenCalledTimes(1)
	})

	it("discards a stale response after the resolution changes", async () => {
		const staleMinute = deferred<GetTaskRateMetricsResponse>()
		mocks.getTaskRateMetrics.mockReturnValueOnce(staleMinute.promise).mockResolvedValueOnce(response(24, 60 * 60 * 1_000))
		const { result, rerender } = renderHook(
			({ resolution }: { resolution: TaskRateMetricsResolution }) =>
				useTaskRateMetrics({ enabled: true, resolution, taskId: "task-1" }),
			{ initialProps: { resolution: "minute" as TaskRateMetricsResolution } },
		)
		await waitFor(() => expect(mocks.getTaskRateMetrics).toHaveBeenCalledTimes(1))

		rerender({ resolution: "hour" })
		await waitFor(() => expect(result.current.data?.points.some(({ activeSeconds }) => activeSeconds === 24)).toBe(true))

		await act(async () => staleMinute.resolve(response(1)))
		expect(result.current.data?.points.some(({ activeSeconds }) => activeSeconds === 24)).toBe(true)
		expect(mocks.getTaskRateMetrics).toHaveBeenLastCalledWith(
			expect.objectContaining({
				resolution: ProtoResolution.TASK_RATE_METRICS_RESOLUTION_HOUR,
				startMs: NOW_MS - 23 * 60 * 60 * 1_000,
				endMs: NOW_MS + 60 * 60 * 1_000,
				maxPoints: 24,
			}),
		)
	})

	it.each(["success", "error"])("isolates a late %s from a previous opening of the same Task", async (settlement) => {
		const previous = deferred<GetTaskRateMetricsResponse>()
		const current = deferred<GetTaskRateMetricsResponse>()
		mocks.getTaskRateMetrics.mockReturnValueOnce(previous.promise).mockReturnValueOnce(current.promise)
		const { result, rerender } = renderHook(
			({ taskInstanceId }) => useTaskRateMetrics({ enabled: true, resolution: "minute", taskId: "task-1", taskInstanceId }),
			{ initialProps: { taskInstanceId: "open-1" } },
		)
		rerender({ taskInstanceId: "open-2" })
		expect(result.current.data).toBeUndefined()
		expect(result.current.error).toBeUndefined()
		await act(async () => {
			if (settlement === "success") previous.resolve(response(1))
			else previous.reject(new Error("old owner failed"))
		})
		expect(result.current.loading).toBe(true)
		expect(result.current.data).toBeUndefined()
		expect(result.current.error).toBeUndefined()
		await act(async () => current.resolve({ ...response(8), taskInstanceId: "open-2" }))
		expect(result.current.data?.points.some(({ activeSeconds }) => activeSeconds === 8)).toBe(true)
		expect(mocks.getTaskRateMetrics).toHaveBeenLastCalledWith(expect.objectContaining({ taskInstanceId: "open-2" }))
	})

	it("does not query without a canonical opening even when a durable Task id exists", () => {
		renderHook(() => useTaskRateMetrics({ enabled: true, resolution: "minute", taskId: "task-1", taskInstanceId: undefined }))
		expect(mocks.getTaskRateMetrics).not.toHaveBeenCalled()
	})

	it("rejects a response tagged with a different Task opening", async () => {
		mocks.getTaskRateMetrics.mockResolvedValueOnce({ ...response(2), taskInstanceId: "previous-open" })
		const { result } = renderHook(() => useTaskRateMetrics({ enabled: true, resolution: "minute", taskId: "task-1" }))
		await waitFor(() => expect(result.current.error).toContain("different Task opening"))
		expect(result.current.data).toBeUndefined()
	})

	it("surfaces an RPC error and retries on demand", async () => {
		mocks.getTaskRateMetrics
			.mockRejectedValueOnce(new Error("history unavailable"))
			.mockResolvedValueOnce(response(2, 24 * 60 * 60 * 1_000))
		const { result } = renderHook(() => useTaskRateMetrics({ enabled: true, resolution: "day", taskId: "task-1" }))

		await waitFor(() => expect(result.current.error).toBe("history unavailable"))
		act(() => result.current.refresh())
		await waitFor(() => expect(result.current.data?.points.some(({ activeSeconds }) => activeSeconds === 2)).toBe(true))
		expect(mocks.getTaskRateMetrics).toHaveBeenCalledTimes(2)
		const dayMs = 24 * 60 * 60 * 1_000
		const dayEndMs = Math.floor(NOW_MS / dayMs) * dayMs + dayMs
		expect(mocks.getTaskRateMetrics).toHaveBeenLastCalledWith(
			expect.objectContaining({
				resolution: ProtoResolution.TASK_RATE_METRICS_RESOLUTION_DAY,
				startMs: dayEndMs - 30 * dayMs,
				endMs: dayEndMs,
				maxPoints: 30,
			}),
		)
	})
})
