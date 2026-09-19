import { Task } from "@core/task"
import { TaskPhase } from "@core/task/TaskPhase"
import { describe, expect, it, vi } from "vitest"

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void
	const promise = new Promise<void>((done) => {
		resolve = done
	})
	return { promise, resolve }
}

function createTerminationRuntime(phase: TaskPhase) {
	return {
		interactionCoordinator: {
			cancelPending: vi.fn(() => 1),
			waitForClaimedContinuations: vi.fn(async () => {}),
			completeCancellation: vi.fn(),
		},
		taskRuntime: {
			getState: vi.fn(() => ({ phase, revision: 1 })),
			waitForDeferredEffectsThrough: vi.fn(async () => {}),
		},
	}
}

describe("Task termination persistence", () => {
	it("waits for API and UI message stores to flush before returning", async () => {
		const apiFlush = deferred()
		const uiFlush = deferred()
		const flushApiConversationHistory = vi.fn(() => apiFlush.promise)
		const flushUiMessages = vi.fn(() => uiFlush.promise)
		const updateTaskHistory = vi.fn(async () => {})
		const publishTaskHistoryClose = vi.fn()
		const terminationRuntime = createTerminationRuntime(TaskPhase.CANCELLING)
		const fakeTask = {
			promptFreshnessInvalidationCoordinator: { dispose: vi.fn() },
			disposePromptInputFileWatcher: vi.fn(async () => {}),
			invalidatePreparedProviderInputs: vi.fn(),
			cancelPendingAutoRetry: vi.fn(),
			modeSwitchCompaction: { abort: vi.fn() },
			shouldRunTaskCancelHook: vi.fn(async () => false),
			...terminationRuntime,
			taskState: { abort: false, abandoned: false, isStreaming: false, cancelOperations: vi.fn() },
			getActiveHookExecution: vi.fn(async () => undefined),
			commandExecutor: { cancelBackgroundCommand: vi.fn(async () => {}), dispose: vi.fn(async () => {}) },
			stateManager: { getGlobalSettingsKey: vi.fn(() => false) },
			flushTaskSnapshot: vi.fn(async () => {}),
			messageStateHandler: {
				flushApiConversationHistory,
				flushUiMessages,
				updateTaskHistory,
				publishTaskHistoryClose,
				close: vi.fn(async () => {}),
			},
			postStateToWebview: vi.fn(async () => {}),
			getCurrentProviderInfo: () => ({
				providerId: "openai",
				mode: "act",
				model: { id: "test-model", info: { capabilities: { contextWindow: 128_000 } } },
			}),
			FocusChainManager: undefined,
			terminalManager: { disposeAll: vi.fn() },
			urlContentFetcher: { closeBrowser: vi.fn() },
			ignoreController: { dispose: vi.fn() },
			taskFileTracker: { dispose: vi.fn() },
			fileContextTracker: { dispose: vi.fn() },
			mcpHub: { removeNotificationCallback: vi.fn() },
			_mcpNotificationCb: undefined,
			activityStore: {
				listRunning: vi.fn(() => []),
				cancel: vi.fn(async () => []),
				dispose: vi.fn(),
				waitForPersistence: vi.fn(async () => {}),
			},
			apiRateMetricsService: { dispose: vi.fn(async () => {}) },
			apiRequestRoundLifecycle: { close: vi.fn(async () => {}) },
			browserSession: { dispose: vi.fn(async () => {}) },
			diffViewProvider: { revertChanges: vi.fn(async () => {}) },
			presentationScheduler: { dispose: vi.fn(async () => {}) },
			stopContextWindowEnvironmentRefresh: vi.fn(),
		} as unknown as Task

		let completed = false
		const termination = Task.prototype.terminate.call(fakeTask).then(() => {
			completed = true
		})

		await vi.waitFor(() => {
			expect(flushApiConversationHistory).toHaveBeenCalled()
			expect(flushUiMessages).toHaveBeenCalled()
		})
		await Promise.resolve()
		expect(completed).toBe(false)

		apiFlush.resolve()
		uiFlush.resolve()
		await termination
		expect(publishTaskHistoryClose).toHaveBeenCalledOnce()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("does not wait for physical History metadata or an unfinished initial checkpoint baseline while closing", async () => {
		const historyUpdate = deferred()
		const updateTaskHistory = vi.fn(() => historyUpdate.promise)
		const publishTaskHistoryClose = vi.fn()
		const terminationRuntime = createTerminationRuntime(TaskPhase.CANCELLING)
		const fakeTask = {
			initialCheckpointCommitPromise: new Promise<string | undefined>(() => undefined),
			promptFreshnessInvalidationCoordinator: { dispose: vi.fn() },
			disposePromptInputFileWatcher: vi.fn(async () => {}),
			invalidatePreparedProviderInputs: vi.fn(),
			cancelPendingAutoRetry: vi.fn(),
			modeSwitchCompaction: { abort: vi.fn() },
			shouldRunTaskCancelHook: vi.fn(async () => false),
			...terminationRuntime,
			taskState: { abort: false, abandoned: false, isStreaming: false, cancelOperations: vi.fn() },
			getActiveHookExecution: vi.fn(async () => undefined),
			commandExecutor: { cancelBackgroundCommand: vi.fn(async () => {}), dispose: vi.fn(async () => {}) },
			stateManager: { getGlobalSettingsKey: vi.fn(() => false) },
			flushTaskSnapshot: vi.fn(async () => {}),
			messageStateHandler: {
				flushApiConversationHistory: vi.fn(async () => {}),
				flushUiMessages: vi.fn(async () => {}),
				updateTaskHistory,
				publishTaskHistoryClose,
				close: vi.fn(async () => {}),
			},
			postStateToWebview: vi.fn(async () => {}),
			getCurrentProviderInfo: () => ({
				providerId: "openai",
				mode: "act",
				model: { id: "test-model", info: { capabilities: { contextWindow: 128_000 } } },
			}),
			FocusChainManager: undefined,
			terminalManager: { disposeAll: vi.fn() },
			urlContentFetcher: { closeBrowser: vi.fn() },
			ignoreController: { dispose: vi.fn() },
			taskFileTracker: { dispose: vi.fn() },
			fileContextTracker: { dispose: vi.fn() },
			mcpHub: { removeNotificationCallback: vi.fn() },
			_mcpNotificationCb: undefined,
			activityStore: {
				listRunning: vi.fn(() => []),
				cancel: vi.fn(async () => []),
				dispose: vi.fn(),
				waitForPersistence: vi.fn(async () => {}),
			},
			apiRateMetricsService: { dispose: vi.fn(async () => {}) },
			apiRequestRoundLifecycle: { close: vi.fn(async () => {}) },
			browserSession: { dispose: vi.fn(async () => {}) },
			diffViewProvider: { revertChanges: vi.fn(async () => {}) },
			presentationScheduler: { dispose: vi.fn(async () => {}) },
			stopContextWindowEnvironmentRefresh: vi.fn(),
		} as unknown as Task

		const termination = Task.prototype.terminate.call(fakeTask)
		const outcome = await Promise.race([
			termination.then(() => "closed" as const),
			new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 25)),
		])
		historyUpdate.resolve()
		await termination

		expect(outcome).toBe("closed")
		expect(publishTaskHistoryClose).toHaveBeenCalledOnce()
		expect(updateTaskHistory).not.toHaveBeenCalled()
	})

	it("preserves a canonical completed snapshot while Start New Task disposes resources", async () => {
		const dispatchRuntime = vi.fn(async () => ({ accepted: true }))
		const flushTaskSnapshot = vi.fn(async () => {})
		const terminationRuntime = {
			interactionCoordinator: {
				cancelPending: vi.fn(() => 1),
				waitForClaimedContinuations: vi.fn(async () => {}),
				completeCancellation: vi.fn(),
			},
			taskRuntime: {
				getState: vi.fn(() => ({
					phase: TaskPhase.COMPLETED,
					revision: 7,
					completion: { completionId: "completion-1" },
				})),
				waitForDeferredEffectsThrough: vi.fn(async () => {}),
			},
		}
		const fakeTask = {
			promptFreshnessInvalidationCoordinator: { dispose: vi.fn() },
			disposePromptInputFileWatcher: vi.fn(async () => {}),
			invalidatePreparedProviderInputs: vi.fn(),
			cancelPendingAutoRetry: vi.fn(),
			modeSwitchCompaction: { abort: vi.fn() },
			shouldRunTaskCancelHook: vi.fn(async () => false),
			...terminationRuntime,
			dispatchRuntime,
			taskState: { abort: false, abandoned: false, isStreaming: false, cancelOperations: vi.fn() },
			getActiveHookExecution: vi.fn(async () => undefined),
			commandExecutor: { cancelBackgroundCommand: vi.fn(async () => true), dispose: vi.fn(async () => {}) },
			stateManager: { getGlobalSettingsKey: vi.fn(() => false) },
			flushTaskSnapshot,
			messageStateHandler: {
				flushApiConversationHistory: vi.fn(async () => {}),
				flushUiMessages: vi.fn(async () => {}),
				updateTaskHistory: vi.fn(async () => {}),
				publishTaskHistoryClose: vi.fn(),
				close: vi.fn(async () => {}),
			},
			postStateToWebview: vi.fn(async () => {}),
			getCurrentProviderInfo: () => ({
				providerId: "openai",
				mode: "act",
				model: { id: "test-model", info: { capabilities: { contextWindow: 128_000 } } },
			}),
			FocusChainManager: undefined,
			terminalManager: { disposeAll: vi.fn() },
			urlContentFetcher: { closeBrowser: vi.fn() },
			ignoreController: { dispose: vi.fn() },
			taskFileTracker: { dispose: vi.fn() },
			fileContextTracker: { dispose: vi.fn() },
			mcpHub: { removeNotificationCallback: vi.fn() },
			_mcpNotificationCb: undefined,
			activityStore: {
				listRunning: vi.fn(() => []),
				cancel: vi.fn(async () => []),
				dispose: vi.fn(),
				waitForPersistence: vi.fn(async () => {}),
			},
			apiRateMetricsService: { dispose: vi.fn(async () => {}) },
			apiRequestRoundLifecycle: { close: vi.fn(async () => {}) },
			browserSession: { dispose: vi.fn(async () => {}) },
			diffViewProvider: { revertChanges: vi.fn(async () => {}) },
			presentationScheduler: { dispose: vi.fn(async () => {}) },
			stopContextWindowEnvironmentRefresh: vi.fn(),
		} as unknown as Task

		await expect(Task.prototype.terminate.call(fakeTask, { preserveCompletedState: true })).resolves.toBeUndefined()

		expect(dispatchRuntime).not.toHaveBeenCalled()
		expect(flushTaskSnapshot).toHaveBeenCalled()
		expect(terminationRuntime.taskRuntime.getState()).toMatchObject({
			phase: TaskPhase.COMPLETED,
			completion: { completionId: "completion-1" },
		})
	})

	it("does not restore a retained approval machine while terminating an executing turn", async () => {
		const dispatchRuntime = vi.fn(async () => ({
			accepted: true,
			next: { phase: TaskPhase.CANCELLING, revision: 2, supersededEffectRevision: 1 },
		}))
		const cancelBackgroundCommand = vi.fn(async () => true)
		const cancelActivities = vi.fn(async () => ["background-subagent"])
		const flushTaskSnapshot = vi.fn(async () => {})
		const flushApiConversationHistory = vi.fn(async () => {})
		const flushUiMessages = vi.fn(async () => {})
		const syncRetainedMachines = vi.fn()
		const terminationRuntime = createTerminationRuntime(TaskPhase.EXECUTING)
		const fakeTask = {
			promptFreshnessInvalidationCoordinator: { dispose: vi.fn() },
			disposePromptInputFileWatcher: vi.fn(async () => {}),
			invalidatePreparedProviderInputs: vi.fn(),
			cancelPendingAutoRetry: vi.fn(),
			modeSwitchCompaction: { abort: vi.fn() },
			shouldRunTaskCancelHook: vi.fn(async () => false),
			...terminationRuntime,
			dispatchRuntime,
			syncRetainedMachines,
			taskState: { abort: false, abandoned: false, isStreaming: false, cancelOperations: vi.fn() },
			getActiveHookExecution: vi.fn(async () => undefined),
			commandExecutor: { cancelBackgroundCommand, dispose: vi.fn(async () => {}) },
			stateManager: { getGlobalSettingsKey: vi.fn(() => false) },
			flushTaskSnapshot,
			messageStateHandler: {
				flushApiConversationHistory,
				flushUiMessages,
				updateTaskHistory: vi.fn(async () => {}),
				publishTaskHistoryClose: vi.fn(),
				close: vi.fn(async () => {}),
			},
			postStateToWebview: vi.fn(async () => {}),
			getCurrentProviderInfo: () => ({
				providerId: "openai",
				mode: "act",
				model: { id: "test-model", info: { capabilities: { contextWindow: 128_000 } } },
			}),
			FocusChainManager: undefined,
			terminalManager: { disposeAll: vi.fn() },
			urlContentFetcher: { closeBrowser: vi.fn() },
			ignoreController: { dispose: vi.fn() },
			taskFileTracker: { dispose: vi.fn() },
			fileContextTracker: { dispose: vi.fn() },
			mcpHub: { removeNotificationCallback: vi.fn() },
			_mcpNotificationCb: undefined,
			activityStore: {
				listRunning: vi.fn(() => [{ activityId: "background-subagent" }]),
				cancel: cancelActivities,
				dispose: vi.fn(),
				waitForPersistence: vi.fn(async () => {}),
			},
			apiRateMetricsService: { dispose: vi.fn(async () => {}) },
			apiRequestRoundLifecycle: { close: vi.fn(async () => {}) },
			browserSession: { dispose: vi.fn(async () => {}) },
			diffViewProvider: { revertChanges: vi.fn(async () => {}) },
			presentationScheduler: { dispose: vi.fn(async () => {}) },
			stopContextWindowEnvironmentRefresh: vi.fn(),
		} as unknown as Task

		await expect(Task.prototype.terminate.call(fakeTask)).resolves.toBeUndefined()

		expect(dispatchRuntime).toHaveBeenCalledWith({ type: "TASK_TERMINATE_REQUESTED" })
		expect(cancelBackgroundCommand).toHaveBeenCalledOnce()
		expect(cancelActivities).toHaveBeenCalledWith(["background-subagent"])
		expect(syncRetainedMachines).not.toHaveBeenCalled()
		expect(flushTaskSnapshot).toHaveBeenCalled()
		expect(flushApiConversationHistory).toHaveBeenCalled()
		expect(flushUiMessages).toHaveBeenCalled()
	})
})
