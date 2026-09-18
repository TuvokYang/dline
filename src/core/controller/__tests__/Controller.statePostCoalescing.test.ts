import type { TaskViewState } from "@shared/ExtensionMessage"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { Controller } from "../index"

vi.mock(import("../state/subscribeToState"), async (importOriginal) => ({
	...(await importOriginal()),
	cleanupStateSubscriptions: vi.fn(() => ({
		subscriberCount: 0,
		hadPendingUpdate: false,
		hadDebounceTimer: false,
		hadSendChain: false,
	})),
	sendStatePatch: vi.fn(async () => undefined),
	sendStateUpdate: vi.fn(async () => undefined),
}))

import { sendStatePatch, sendStateUpdate } from "../state/subscribeToState"

type BuildSpy = ReturnType<typeof vi.fn>

/**
 * Build a controller whose state build is observable and free of real IO.
 *
 * Only the collaborators that postStateToWebview actually touches are
 * supplied, so a regression in the coalescing path cannot be masked by an
 * unrelated stub resolving first.
 */
function createController(taskId?: string): { controller: Controller; buildState: BuildSpy; setActiveTaskId: BuildSpy } {
	const controller = Object.create(Controller.prototype) as Controller
	const setActiveTaskId = vi.fn()
	let revision = 0
	const buildState = vi.fn(async () => ({ stateRevision: revision }) as never)

	Object.assign(controller, {
		uiDetached: false,
		disposed: false,
		suppressedStatePostsAfterDetach: 0,
		stateBuildsAfterDetach: 0,
		nextStateRevision: 0,
		latestStateRevision: 0,
		pendingStatePostTimer: undefined,
		_accountUsage: undefined,
		task: taskId ? { taskId } : undefined,
		stateManager: { setActiveTaskId },
	})

	vi.spyOn(controller as Controller & { buildState(r: number): Promise<never> }, "buildState").mockImplementation(
		async (r: number) => {
			revision = r
			return buildState() as never
		},
	)

	return { controller, buildState, setActiveTaskId }
}

describe("Controller state publication coalescing", () => {
	beforeEach(() => {
		vi.mocked(sendStatePatch).mockClear()
		vi.mocked(sendStateUpdate).mockClear()
	})

	it("builds state once for a burst of ordinary publications", async () => {
		vi.useFakeTimers()
		try {
			const { controller, buildState } = createController()

			await controller.postStateToWebview()
			await controller.postStateToWebview()
			await controller.postStateToWebview()

			// The whole point of merging before the build: a burst must not pay
			// for three full builds that are then thrown away.
			expect(buildState).not.toHaveBeenCalled()

			await vi.advanceTimersByTimeAsync(50)

			expect(buildState).toHaveBeenCalledTimes(1)
			expect(sendStateUpdate).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it("builds and sends an immediate publication without waiting", async () => {
		vi.useFakeTimers()
		try {
			const { controller, buildState } = createController()

			await controller.postStateToWebview({ immediate: true })

			expect(buildState).toHaveBeenCalledTimes(1)
			expect(sendStateUpdate).toHaveBeenCalledTimes(1)
			expect(vi.mocked(sendStateUpdate).mock.calls[0]?.[3]).toEqual({ immediate: true })
		} finally {
			vi.useRealTimers()
		}
	})

	it("publishes an interaction-critical Task view without building full state", async () => {
		const { controller, buildState, setActiveTaskId } = createController("task-a")
		const taskViewState = { taskId: "task-a", stateRevision: 7 } as TaskViewState
		vi.spyOn(
			controller as unknown as { projectCurrentTaskViewState(): TaskViewState | undefined },
			"projectCurrentTaskViewState",
		).mockReturnValue(taskViewState)

		await controller.postTaskViewPatchToWebview()

		expect(setActiveTaskId).toHaveBeenCalledWith("task-a")
		expect(buildState).not.toHaveBeenCalled()
		expect(sendStatePatch).toHaveBeenCalledWith(controller, { stateRevision: 1, taskViewState }, undefined)
	})

	it("lets an immediate publication supersede a pending merge window", async () => {
		vi.useFakeTimers()
		try {
			const { controller, buildState } = createController()

			await controller.postStateToWebview()
			await controller.postStateToWebview({ immediate: true })
			await vi.advanceTimersByTimeAsync(50)

			// The pending window must be dropped rather than firing a second
			// redundant build after the immediate one already published.
			expect(buildState).toHaveBeenCalledTimes(1)
			expect(sendStateUpdate).toHaveBeenCalledTimes(1)
		} finally {
			vi.useRealTimers()
		}
	})

	it("synchronizes the active task id before the build is deferred", async () => {
		vi.useFakeTimers()
		try {
			const { controller, setActiveTaskId } = createController("task-a")

			await controller.postStateToWebview()

			// buildState is the only writer of the active task id, so deferring it
			// without this would leave task-scoped setting reads on the old task
			// for the whole merge window.
			expect(setActiveTaskId).toHaveBeenCalledWith("task-a")
		} finally {
			vi.useRealTimers()
		}
	})

	it("drops a pending merge window when the UI detaches", async () => {
		vi.useFakeTimers()
		try {
			const { controller, buildState } = createController()

			await controller.postStateToWebview()
			controller.detachUi()
			await vi.advanceTimersByTimeAsync(50)

			expect(buildState).not.toHaveBeenCalled()
			expect(sendStateUpdate).not.toHaveBeenCalled()
		} finally {
			vi.useRealTimers()
		}
	})

	it("suppresses publications requested after detach", async () => {
		const { controller, buildState } = createController()
		controller.detachUi()

		await controller.postStateToWebview({ immediate: true })

		expect(buildState).not.toHaveBeenCalled()
		expect(sendStateUpdate).not.toHaveBeenCalled()
	})
})
