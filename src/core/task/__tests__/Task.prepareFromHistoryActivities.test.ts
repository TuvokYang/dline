import { describe, expect, it, vi } from "vitest"
import { Task } from "../index"

describe("Task.prepareFromHistory readiness", () => {
	it("publishes canonical Resume and readiness without starting execution maintenance", async () => {
		const order: string[] = []
		const maintenance = new Promise<void>(() => undefined)
		const task = {
			taskId: "task-1",
			taskState: { abort: false },
			resumeCoordinator: {
				prepare: vi.fn(async () => {
					order.push("resume")
				}),
			},
			startContextWindowEnvironmentRefresh: vi.fn(() => {
				order.push("environment")
			}),
			ensureApiRateMetricsInitialized: vi.fn(async () => undefined),
			historyResumeMaintenance: {
				run: vi.fn(() => {
					order.push("maintenance")
					return maintenance
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
		expect(order).toEqual(["resume", "ready"])
		const resources = task as unknown as {
			startContextWindowEnvironmentRefresh: ReturnType<typeof vi.fn>
			historyResumeMaintenance: { run: ReturnType<typeof vi.fn> }
		}
		expect(resources.startContextWindowEnvironmentRefresh).not.toHaveBeenCalled()
		expect(resources.historyResumeMaintenance.run).not.toHaveBeenCalled()
	})

	it("clears the preparing projection and republishes state when canonical preparation fails", async () => {
		const failure = new Error("snapshot unreadable")
		const postStateToWebview = vi.fn(async () => undefined)
		const task = {
			taskId: "task-1",
			taskState: { abort: false },
			historyPreparationPending: true,
			resumeCoordinator: { prepare: vi.fn(async () => Promise.reject(failure)) },
			postStateToWebview,
			startContextWindowEnvironmentRefresh: vi.fn(),
			ensureApiRateMetricsInitialized: vi.fn(async () => undefined),
			historyResumeMaintenance: { run: vi.fn(async () => undefined) },
		} as unknown as Task

		await expect(Task.prototype.prepareFromHistory.call(task)).rejects.toBe(failure)

		const internal = task as unknown as {
			historyPreparationPending: boolean
			startContextWindowEnvironmentRefresh: ReturnType<typeof vi.fn>
			historyResumeMaintenance: { run: ReturnType<typeof vi.fn> }
		}
		expect(task.taskState.abort).toBe(true)
		expect(internal.historyPreparationPending).toBe(false)
		expect(postStateToWebview).toHaveBeenCalledWith({ immediate: true })
		expect(internal.startContextWindowEnvironmentRefresh).not.toHaveBeenCalled()
		expect(internal.historyResumeMaintenance.run).not.toHaveBeenCalled()
	})

	it("does not start maintenance after readiness loses Task identity", async () => {
		let isCurrent = true
		const run = vi.fn(async () => undefined)
		const task = {
			taskId: "task-1",
			taskState: { abort: false },
			resumeCoordinator: { prepare: vi.fn(async () => undefined) },
			startContextWindowEnvironmentRefresh: vi.fn(),
			ensureApiRateMetricsInitialized: vi.fn(async () => undefined),
			historyResumeMaintenance: { run },
		} as unknown as Task

		await Task.prototype.prepareFromHistory.call(task, {
			isCurrent: () => isCurrent,
			onReadyToDisplay: async () => {
				isCurrent = false
			},
		})

		expect(run).not.toHaveBeenCalled()
	})
})
