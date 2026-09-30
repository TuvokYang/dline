import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface StreamCallbacks {
	onResponse: (update: {
		taskId: string
		taskInstanceId: string
		snapshot: boolean
		activities: Array<{ activityId: string }>
	}) => void
	onError: (error: unknown) => void
	onComplete: () => void
}

const openStreams: StreamCallbacks[] = []
const cancelSpy = vi.fn()

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		subscribeToTaskActivities: (_request: unknown, callbacks: StreamCallbacks) => {
			openStreams.push(callbacks)
			return cancelSpy
		},
		cancelTaskActivities: vi.fn(),
		finishTaskActivities: vi.fn(),
		retryTaskActivities: vi.fn(),
		moveCommandToBackground: vi.fn(),
	},
}))

vi.mock("@shared/proto/dline/task", () => ({
	CancelTaskActivitiesRequest: { create: (value: unknown) => value },
	FinishTaskActivitiesRequest: { create: (value: unknown) => value },
	MoveCommandToBackgroundRequest: { create: (value: unknown) => value },
	RetryTaskActivitiesRequest: { create: (value: unknown) => value },
	TaskActivitySubscriptionRequest: { create: (value: unknown) => value },
}))

const { useTaskActivities } = await import("./useTaskActivities")

describe("useTaskActivities", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		openStreams.length = 0
		cancelSpy.mockClear()
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	it("re-attaches after the backend closes the stream before the task is current", () => {
		const { result, unmount } = renderHook(() => useTaskActivities("task-1", "open-1"))
		expect(openStreams).toHaveLength(1)

		act(() => {
			openStreams[0].onResponse({
				taskId: "task-1",
				taskInstanceId: "open-1",
				snapshot: true,
				activities: [{ activityId: "stale-job" }],
			})
		})
		expect(result.current.getById("stale-job")).toBeDefined()

		// The backend sends one terminal empty snapshot when the requested task is
		// not yet current. The response clears stale data before completion schedules
		// a new stream for the same task.
		act(() => {
			openStreams[0].onResponse({ taskId: "task-1", taskInstanceId: "open-1", snapshot: true, activities: [] })
			openStreams[0].onComplete()
		})
		expect(result.current.getById("stale-job")).toBeUndefined()
		act(() => {
			vi.advanceTimersByTime(500)
		})

		// Without a re-attach the view would stay empty forever, which is exactly
		// how a running subagent ends up rendering frozen zero metrics.
		expect(openStreams).toHaveLength(2)

		act(() => {
			openStreams[1].onResponse({
				taskId: "task-1",
				taskInstanceId: "open-1",
				snapshot: true,
				activities: [{ activityId: "job-1" }],
			})
		})
		expect(result.current.getById("job-1")).toBeDefined()

		// A later history recovery can hit the same startup race again. Each
		// terminal response must independently clear the stale snapshot and create
		// another live stream rather than leaving the shared subscription orphaned.
		act(() => {
			openStreams[1].onResponse({ taskId: "task-1", taskInstanceId: "open-1", snapshot: true, activities: [] })
			openStreams[1].onComplete()
		})
		expect(result.current.getById("job-1")).toBeUndefined()
		act(() => {
			vi.advanceTimersByTime(500)
		})
		expect(openStreams).toHaveLength(3)

		act(() => {
			openStreams[2].onResponse({
				taskId: "task-1",
				taskInstanceId: "open-1",
				snapshot: true,
				activities: [{ activityId: "job-1" }],
			})
		})
		expect(result.current.getById("job-1")).toBeDefined()

		unmount()
	})

	it("re-attaches after a stream error", () => {
		const { unmount } = renderHook(() => useTaskActivities("task-2", "open-1"))
		expect(openStreams).toHaveLength(1)

		act(() => {
			openStreams[0].onError(new Error("stream failed"))
		})
		act(() => {
			vi.advanceTimersByTime(500)
		})

		expect(openStreams).toHaveLength(2)
		unmount()
	})

	it("isolates same-ID reopen from old responses, errors, completion and retry timers", () => {
		const { result, rerender, unmount } = renderHook(({ instance }) => useTaskActivities("same-task", instance), {
			initialProps: { instance: "open-1" },
		})
		const old = openStreams[0]
		act(() => {
			old.onComplete()
		})
		rerender({ instance: "open-2" })
		expect(openStreams).toHaveLength(2)
		act(() => {
			openStreams[1].onResponse({
				taskId: "same-task",
				taskInstanceId: "open-2",
				snapshot: true,
				activities: [{ activityId: "current" }],
			})
			old.onResponse({ taskId: "same-task", taskInstanceId: "open-1", snapshot: true, activities: [{ activityId: "old" }] })
			old.onError(new Error("late old error"))
			old.onComplete()
			vi.advanceTimersByTime(1_000)
		})
		expect(result.current.getById("current")).toBeDefined()
		expect(result.current.getById("old")).toBeUndefined()
		expect(openStreams).toHaveLength(2)
		unmount()
	})

	it("does not re-attach after the last consumer unmounts", () => {
		const { unmount } = renderHook(() => useTaskActivities("task-3", "open-1"))
		expect(openStreams).toHaveLength(1)

		act(() => {
			openStreams[0].onComplete()
		})
		unmount()
		act(() => {
			vi.advanceTimersByTime(500)
		})

		// A pending re-attach must not resurrect a subscription nobody is reading.
		expect(openStreams).toHaveLength(1)
	})
})
