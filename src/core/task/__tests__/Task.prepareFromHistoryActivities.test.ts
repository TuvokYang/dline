import { describe, expect, it, vi } from "vitest"
import { Task } from "../index"

const runHistoryPreparation = (
	Task.prototype as unknown as {
		runHistoryPreparation(
			this: Task,
			options?: { isCurrent?: () => boolean; onReadyToDisplay?: () => Promise<void> },
		): Promise<void>
	}
).runHistoryPreparation

describe("Task.prepareFromHistory readiness", () => {
	it("keeps Resume gated until watcher, metrics, and reconciliation complete", async () => {
		const order: string[] = []
		const task = {
			taskId: "task-1",
			taskState: { abort: false },
			historyPreparationPending: true,
			controllerDetached: false,
			ensurePromptInputFileWatcherInitialized: vi.fn(async () => {
				order.push("watcher")
			}),
			ensureApiRateMetricsInitialized: vi.fn(async () => {
				order.push("metrics")
			}),
			resumeCoordinator: {
				prepare: vi.fn(async () => {
					order.push("resume")
				}),
			},
			controller: {
				postTaskViewPatchToWebview: vi.fn(async () => {
					order.push("patch")
				}),
			},
		} as unknown as Task

		await runHistoryPreparation.call(task, {
			isCurrent: () => true,
			onReadyToDisplay: async () => {
				order.push("ready")
			},
		})

		expect(task.taskState.abort).toBe(true)
		expect(order).toEqual(["watcher", "metrics", "resume", "patch", "ready"])
		expect((task as unknown as { historyPreparationPending: boolean }).historyPreparationPending).toBe(false)
	})

	it("keeps the preparing projection gated when canonical preparation fails", async () => {
		const failure = new Error("snapshot unreadable")
		const postTaskViewPatchToWebview = vi.fn(async () => undefined)
		const task = {
			taskId: "task-1",
			taskState: { abort: false },
			historyPreparationPending: true,
			controllerDetached: false,
			ensurePromptInputFileWatcherInitialized: vi.fn(async () => undefined),
			ensureApiRateMetricsInitialized: vi.fn(async () => undefined),
			resumeCoordinator: { prepare: vi.fn(async () => Promise.reject(failure)) },
			controller: { postTaskViewPatchToWebview },
		} as unknown as Task

		await expect(runHistoryPreparation.call(task)).rejects.toBe(failure)

		expect(task.taskState.abort).toBe(true)
		expect((task as unknown as { historyPreparationPending: boolean }).historyPreparationPending).toBe(true)
		expect(postTaskViewPatchToWebview).not.toHaveBeenCalled()
	})

	it("does not publish an enabled patch after readiness loses Task identity", async () => {
		let isCurrent = true
		const postTaskViewPatchToWebview = vi.fn(async () => undefined)
		const task = {
			taskId: "task-1",
			taskState: { abort: false },
			historyPreparationPending: true,
			controllerDetached: false,
			ensurePromptInputFileWatcherInitialized: vi.fn(async () => undefined),
			ensureApiRateMetricsInitialized: vi.fn(async () => undefined),
			resumeCoordinator: {
				prepare: vi.fn(async () => {
					isCurrent = false
				}),
			},
			controller: { postTaskViewPatchToWebview },
		} as unknown as Task

		await runHistoryPreparation.call(task, { isCurrent: () => isCurrent })

		expect((task as unknown as { historyPreparationPending: boolean }).historyPreparationPending).toBe(true)
		expect(postTaskViewPatchToWebview).not.toHaveBeenCalled()
	})

	it("clears the historical stop state before preparing execution for an accepted interaction", async () => {
		type PreparationHarness = {
			controllerDetached: boolean
			readOnly: boolean
			executionPreparationFenced: boolean
			taskState: {
				abort: boolean
				autoRetryAttempts: number
				resetOperationCancellation(): void
			}
			resetResumeExecutionState(): void
			prepareExecutionResources(): Promise<void>
		}
		const taskPrototype = Task.prototype as unknown as {
			resetResumeExecutionState(this: PreparationHarness): void
			prepareExecutionResourcesForAcceptedInteraction(this: PreparationHarness): Promise<void>
		}
		const resetOperationCancellation = vi.fn()
		const taskState = { abort: true, autoRetryAttempts: 2, resetOperationCancellation }
		const prepareExecutionResources = vi.fn(async () => {
			expect(taskState.abort).toBe(false)
			expect(taskState.autoRetryAttempts).toBe(0)
		})
		const task: PreparationHarness = {
			controllerDetached: false,
			readOnly: false,
			executionPreparationFenced: false,
			taskState,
			resetResumeExecutionState() {
				taskPrototype.resetResumeExecutionState.call(this)
			},
			prepareExecutionResources,
		}

		await taskPrototype.prepareExecutionResourcesForAcceptedInteraction.call(task)

		expect(resetOperationCancellation).toHaveBeenCalledOnce()
		expect(prepareExecutionResources).toHaveBeenCalledOnce()
	})
})
