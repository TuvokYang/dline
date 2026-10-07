import { sendPartialMessageEvent } from "@core/controller/ui/subscribeToPartialMessage"
import { describe, expect, it, vi } from "vitest"
import { Task } from "../index"

// A factory without importOriginal: the real module sits in an import cycle with
// the generated ProtoBus registry, so every export is replaced explicitly.
vi.mock("@core/controller/ui/subscribeToPartialMessage", () => ({
	subscribeToPartialMessage: vi.fn(async () => undefined),
	registerPartialMessageCallback: vi.fn(() => () => undefined),
	sendPartialMessageEvent: vi.fn(async () => undefined),
}))

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
			recoverInterruptedHistoryActivities: vi.fn(async () => {
				order.push("interrupted")
			}),
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
		expect(order).toEqual(["watcher", "metrics", "resume", "interrupted", "patch", "ready"])
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
			recoverInterruptedHistoryActivities: vi.fn(async () => undefined),
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
			recoverInterruptedHistoryActivities: vi.fn(async () => undefined),
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

	it("admits an Activity Retry on a reopened Task through the accepted-interaction path", async () => {
		const order: string[] = []
		const restoreSubagentRetry = vi.fn(async () => {
			order.push("retry")
			return true
		})
		const task = {
			controllerDetached: false,
			readOnly: false,
			restoredFromHistory: true,
			prepareExecutionResourcesForAcceptedInteraction: vi.fn(async () => {
				order.push("admit")
			}),
			prepareExecutionResources: vi.fn(async () => {
				order.push("prepare-only")
			}),
			toolExecutor: { restoreSubagentRetry },
		}
		const restoreSubagentActivityRetry = (
			Task.prototype as unknown as { restoreSubagentActivityRetry(this: typeof task, id: string): Promise<boolean> }
		).restoreSubagentActivityRetry

		await expect(restoreSubagentActivityRetry.call(task, "subagent-1")).resolves.toBe(true)
		expect(order).toEqual(["admit", "retry"])
		expect(restoreSubagentRetry).toHaveBeenCalledWith("subagent-1")

		order.length = 0
		task.restoredFromHistory = false
		await restoreSubagentActivityRetry.call(task, "subagent-2")
		expect(order).toEqual(["prepare-only", "retry"])
	})

	it("recovers interrupted command cards before execution stores exist", async () => {
		const runningCard = { ts: 10, type: "ask", ask: "command", activityId: "cmd-1", commandStatus: "running" }
		const unrelatedCard = { ts: 11, type: "ask", ask: "command", activityId: "cmd-2", commandStatus: "running" }
		const persistMessage = vi.fn(async (message: Record<string, unknown>) => message)
		const updateClineMessage = vi.fn(async () => undefined)
		const task = {
			taskId: "task-1",
			messageResources: { hasExecutionStores: false, persistMessage },
			messageStateHandler: { clineMessages: [runningCard, unrelatedCard], updateClineMessage },
			controller: {},
		}
		const patchInterruptedCommandCards = (
			Task.prototype as unknown as {
				patchInterruptedCommandCards(this: typeof task, ids: ReadonlySet<string>): Promise<void>
			}
		).patchInterruptedCommandCards

		await patchInterruptedCommandCards.call(task, new Set(["cmd-1"]))

		expect(persistMessage).toHaveBeenCalledOnce()
		expect(persistMessage).toHaveBeenCalledWith({ ...runningCard, commandStatus: "interrupted" })
		expect(updateClineMessage).not.toHaveBeenCalled()
		expect(sendPartialMessageEvent).toHaveBeenCalledOnce()
	})

	it("keeps history readiness available when interrupted activity recovery fails", async () => {
		const task = {
			taskId: "task-1",
			controllerDetached: false,
			activityStore: {
				recoverInterruptedActivities: vi.fn(async () => Promise.reject(new Error("activities unreadable"))),
			},
			patchInterruptedCommandCards: vi.fn(async () => undefined),
		}
		const recoverInterruptedHistoryActivities = (
			Task.prototype as unknown as { recoverInterruptedHistoryActivities(this: typeof task): Promise<void> }
		).recoverInterruptedHistoryActivities

		await expect(recoverInterruptedHistoryActivities.call(task)).resolves.toBeUndefined()
		expect(task.patchInterruptedCommandCards).not.toHaveBeenCalled()
	})
})
