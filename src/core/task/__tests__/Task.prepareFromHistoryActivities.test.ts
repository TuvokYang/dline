import { describe, expect, it, vi } from "vitest"
import { Task } from "../index"

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

		await Task.prototype.prepareFromHistory.call(task, {
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

		await expect(Task.prototype.prepareFromHistory.call(task)).rejects.toBe(failure)

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

		await Task.prototype.prepareFromHistory.call(task, { isCurrent: () => isCurrent })

		expect((task as unknown as { historyPreparationPending: boolean }).historyPreparationPending).toBe(true)
		expect(postTaskViewPatchToWebview).not.toHaveBeenCalled()
	})
})
