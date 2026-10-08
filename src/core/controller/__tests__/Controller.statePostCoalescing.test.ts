import { createInitialTaskState } from "@core/task/kernel"
import { projectCanonicalTaskView } from "@core/task/view/canonical/projectCanonicalTaskView"
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
		publicationSequence: 0,
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

	// A reopened task publishes its restored dialog through the interaction
	// patch rather than a full state build. Projecting that patch without the
	// task's rows left the anchor unresolved, so the composer stayed disabled
	// and the interaction was never offered: the task looked permanently stuck
	// even though its dialog was awaiting an answer.
	it("projects the interaction patch against the task's own messages", async () => {
		const { controller } = createController("task-a")
		const initial = createInitialTaskState("task-a")
		const view = projectCanonicalTaskView({
			...initial,
			revision: 7,
			flow: { phase: "paused" },
			dialog: {
				approvalsByBlock: {},
				primary: {
					interactionId: "interaction-1",
					turnId: "turn-1",
					kind: "completion",
					status: "awaiting",
					createdRevision: 6,
					presentationRef: "completion:turn-1",
					receiverGeneration: 0,
					actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
				},
			},
		})
		Object.assign(controller, {
			task: {
				taskId: "task-a",
				writable: true,
				projectView: () => view,
				owners: {
					messages: {
						clineMessages: [
							{
								type: "ask",
								ask: "completion_result",
								ts: 20,
								text: "done",
								interactionId: "interaction-1",
								partial: false,
							},
						],
					},
					commands: {
						getReadyBackgroundHandoffActivityId: () => undefined,
						isBackgroundHandoffRequested: () => false,
					},
				},
			},
		})

		await controller.postTaskViewPatchToWebview()

		const patched = vi.mocked(sendStatePatch).mock.calls[0]?.[1] as { taskViewState?: TaskViewState }
		expect(patched.taskViewState?.activeInteraction).toMatchObject({
			interactionId: "interaction-1",
			status: "awaiting",
			askMessageTs: 20,
		})
		expect(patched.taskViewState?.input).toMatchObject({ enabled: true, enterAction: "reply" })
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

	/** Let a released build's promise chain run to its end. */
	async function settle(): Promise<void> {
		for (let turn = 0; turn < 20; turn++) await Promise.resolve()
	}

	/** Hold the first state build open until released; later builds finish at once. */
	function holdFirstBuild(controller: Controller): { release(): void; builds(): number } {
		let release!: () => void
		const firstBuild = new Promise<void>((resolve) => {
			release = resolve
		})
		let builds = 0
		vi.spyOn(controller as Controller & { buildState(r: number): Promise<never> }, "buildState").mockImplementation(
			async (revision: number) => {
				builds++
				if (builds === 1) await firstBuild
				return { stateRevision: revision } as never
			},
		)
		return { release, builds: () => builds }
	}

	it("publishes again when a state read that never delivers overtakes a publication", async () => {
		vi.useFakeTimers()
		try {
			const { controller } = createController()
			const build = holdFirstBuild(controller)

			await controller.postStateToWebview()
			await vi.advanceTimersByTimeAsync(50)
			// A unary read (getLatestState, getProcessInfo) finishes while the
			// publication is still building, which makes that build stale.
			await controller.getStateToPostToWebview()
			build.release()
			await settle()
			expect(sendStateUpdate).not.toHaveBeenCalled()

			// Nothing else will publish once a dialog is revealed, so the dropped
			// build must be replaced by one that reaches the webview.
			await vi.advanceTimersByTimeAsync(50)
			await settle()
			expect(sendStateUpdate).toHaveBeenCalledTimes(1)
			expect(build.builds()).toBe(3)
			expect(vi.mocked(sendStateUpdate).mock.calls[0]?.[1]).toMatchObject({ stateRevision: 3 })
		} finally {
			vi.useRealTimers()
		}
	})

	it("does not publish again when a newer publication overtook the dropped build", async () => {
		vi.useFakeTimers()
		try {
			const { controller } = createController()
			const build = holdFirstBuild(controller)

			await controller.postStateToWebview()
			await vi.advanceTimersByTimeAsync(50)
			await controller.postStateToWebview({ immediate: true })
			build.release()
			await settle()
			await vi.advanceTimersByTimeAsync(100)
			await settle()

			expect(build.builds()).toBe(2)
			expect(sendStateUpdate).toHaveBeenCalledTimes(1)
			expect(vi.mocked(sendStateUpdate).mock.calls[0]?.[1]).toMatchObject({ stateRevision: 2 })
		} finally {
			vi.useRealTimers()
		}
	})
})
