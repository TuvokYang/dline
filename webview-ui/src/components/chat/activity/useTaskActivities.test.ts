import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface StreamCallbacks {
	onResponse: (update: { snapshot: boolean; activities: Array<{ activityId: string }> }) => void
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
		const { result, unmount } = renderHook(() => useTaskActivities("task-1"))
		expect(openStreams).toHaveLength(1)

		// The backend ends the stream immediately when the requested task is not
		// yet the controller's current task, which is a normal startup race.
		act(() => {
			openStreams[0].onComplete()
		})
		act(() => {
			vi.advanceTimersByTime(500)
		})

		// Without a re-attach the view would stay empty forever, which is exactly
		// how a running subagent ends up rendering frozen zero metrics.
		expect(openStreams).toHaveLength(2)

		act(() => {
			openStreams[1].onResponse({ snapshot: true, activities: [{ activityId: "job-1" }] })
		})
		expect(result.current.getById("job-1")).toBeDefined()

		unmount()
	})

	it("re-attaches after a stream error", () => {
		const { unmount } = renderHook(() => useTaskActivities("task-2"))
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

	it("does not re-attach after the last consumer unmounts", () => {
		const { unmount } = renderHook(() => useTaskActivities("task-3"))
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
